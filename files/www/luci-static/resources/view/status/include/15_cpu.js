'use strict';
'require baseclass';
'require fs';
'require view.status.nss-i18n as i18n';

var t = i18n.t;

function parseCpu(lines) {
	var cpus = {};

	lines.forEach(function(line) {
		var m = line.match(/^(cpu\d*)\s+(.+)$/);

		if (!m)
			return;

		cpus[m[1]] = m[2].trim().split(/\s+/).map(Number);
	});

	return cpus;
}

function sample() {
	/* fs.lines() 逐行 trim，且不会 reject：读不到时返回空数组 */
	return fs.lines('/proc/stat').then(parseCpu);
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

/* 占用率来自两次采样的 tick 增量差分。基线留在模块里：上一轮的累计
 * 计数直接给下一轮当差分基准，load() 就不必再等一个测量窗——状态页
 * 每轮轮询都 await 全部卡片的 load()（luci-mod-status 的
 * view/status/index.js），在 load() 里等待会把整页刷新一起拖住。
 * 没有可用基线时（首帧、卡片被隐藏过、后台挂起）退回一次短窗实测。 */
var prev = null;
var WINDOW = 1200;    /* 实测窗口，毫秒 */
var MAX_GAP = 60000;  /* 基线超过这个间隔就作废，重新实测 */

function measure() {
	return sample().then(function(cur) {
		var now = Date.now();

		if (prev && (now - prev.ts) <= MAX_GAP) {
			var res = { usage: calcUsage(cur, prev.data), empty: Object.keys(cur).length == 0 };

			prev = { ts: now, data: cur };

			return res;
		}

		return new Promise(function(resolve) {
			setTimeout(function() {
				sample().then(function(next) {
					prev = { ts: Date.now(), data: next };

					resolve({ usage: calcUsage(next, cur), empty: Object.keys(next).length == 0 });
				});
			}, WINDOW);
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
