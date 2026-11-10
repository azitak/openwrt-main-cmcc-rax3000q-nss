'use strict';
'require baseclass';
'require fs';

/* 默认英语；界面语言为中文时显示中文 */
var ZH = String(document.documentElement.lang || '').toLowerCase().indexOf('zh') === 0;
function t(en, zh) { return ZH ? zh : en; }

function parseCpu(text) {
	var cpus = {};

	(text || '').split('\n').forEach(function(line) {
		var m = line.match(/^(cpu\d*)\s+(.+)$/);

		if (!m)
			return;

		cpus[m[1]] = m[2].trim().split(/\s+/).map(Number);
	});

	return cpus;
}

function sample() {
	/* fs.read 在 RPC 失败时会静默回退为空串，这里兜住剩余的 reject 路径 */
	return L.resolveDefault(fs.read('/proc/stat'), '').then(parseCpu);
}

function usage(cur, old) {
	var total = 0, idle = 0, ptotal = 0, pidle = 0;

	for (var i = 0; i < 8; i++) {
		total += cur[i] || 0;
		ptotal += old[i] || 0;

		if (i === 3 || i === 4) {
			idle += cur[i] || 0;
			pidle += old[i] || 0;
		}
	}

	var dt = total - ptotal, di = idle - pidle;

	/* tickless idle 下整窗可能没有任何 tick 增量：视为 0% */
	return (dt <= 0) ? 0 : 100 * (dt - di) / dt;
}

function calcUsage(cur, old) {
	var out = {};

	Object.keys(cur).forEach(function(k) {
		if (old[k]) {
			var u = usage(cur[k], old[k]);

			if (u != null)
				out[k] = u;
		}
	});

	return out;
}

/* 官方卡片均为无状态设计：index.js 每个轮询周期都重新调用 load()，
 * render() 是 load() 数据的纯函数。占用率由 /proc/stat 两次采样的
 * tick 增量差分而来，因此把完整测量窗封闭在单次 load() 内，不保留
 * 任何跨周期基线——刷新、解除隐藏、跳页返回、后台切回，首帧均为
 * 当次实测的占用率。窗口取 1.2 s：tickless idle 下短窗口可能没有
 * tick 增量。 */
function measure() {
	return sample().then(function(cur) {
		return new Promise(function(resolve) {
			setTimeout(function() {
				sample().then(function(next) {
					resolve({
						usage: Object.keys(next).length > 0 ? calcUsage(next, cur) : {},
						empty: Object.keys(next).length == 0
					});
				});
			}, 1200);
		});
	});
}

/* 官方“内存”/“存储”卡片同款进度条 helper：title 显示 "x / y (z%)" */
function progressbar(value, max) {
	var vn = parseInt(value) || 0, mn = parseInt(max) || 100,
	    fv = value, fm = max, pc = Math.floor((100 / mn) * vn);

	return E('div', { 'class': 'cbi-progressbar',
	                  'title': '%s / %s (%d%%)'.format(fv, fm, pc) },
		E('div', { 'style': 'width:%.2f%%'.format(pc) }));
}

/* 一行一个进度条：左标签、右进度条；无数据时按官方 30_network 卡的
 * 惯例显示 ? */
function renderRow(label, pct) {
	var has = (pct != null && !isNaN(pct));

	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '25%' }, label),
		E('td', { 'class': 'td left' }, has ? progressbar(pct.toFixed(1), 100) : '?')
	]);
}

return baseclass.extend({
	title: t('CPU usage', 'CPU 占用'),

	load: function() {
		return measure();
	},

	render: function(s) {
		/* /proc/stat 完全读不到：返回 null 让上层保留上一帧 DOM */
		if (!s || s.empty)
			return null;

		var u = s.usage || null;

		var table = E('table', { 'class': 'table' });

		table.appendChild(renderRow(t('Total', '总计'), u ? u['cpu'] : null));
		table.appendChild(renderRow('cpu0', u ? u['cpu0'] : null));
		table.appendChild(renderRow('cpu1', u ? u['cpu1'] : null));

		return table;
	}
});
