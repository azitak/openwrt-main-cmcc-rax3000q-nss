'use strict';
'require baseclass';
'require fs';

/* 默认英语；界面语言为中文时显示中文 */
var ZH = String(document.documentElement.lang || '').toLowerCase().indexOf('zh') === 0;
function t(en, zh) { return ZH ? zh : en; }

var prev = null;

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
	return fs.read('/proc/stat').then(function(text) {
		return parseCpu(text);
	});
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

	if (dt <= 0)
		return null;

	return 100 * (dt - di) / dt;
}

function collect() {
	return sample().then(function(cur) {
		if (prev) {
			var dt = (Date.now() - prev.t) / 1000;
			var usage_map = {};

			if (dt >= 1) {
				Object.keys(cur).forEach(function(k) {
					if (prev.cpus[k]) {
						var u = usage(cur[k], prev.cpus[k]);

						if (u != null)
							usage_map[k] = u;
					}
				});
			}

			prev = { t: Date.now(), cpus: cur };
			return { usage: usage_map };
		}

		/* 首次加载：等 1.2 s 再采一次（tickless idle 下 500ms 可能无 tick 增量）*/
		return new Promise(function(resolve) {
			setTimeout(function() {
				sample().then(function(next) {
					var usage_map = {};

					Object.keys(next).forEach(function(k) {
						if (cur[k]) {
							var u = usage(next[k], cur[k]);

							if (u != null)
								usage_map[k] = u;
						}
					});

					prev = { t: Date.now(), cpus: next };
					resolve({ usage: usage_map });
				});
			}, 1200);
		});
	});
}

/* 一行一个进度条：左标签、右百分比，与首页“内存”卡片同构 */
function renderRow(label, pct) {
	var has = (pct != null && !isNaN(pct));
	var v = has ? pct : 0;

	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '25%' }, label),
		E('td', { 'class': 'td left' },
			E('div', { 'class': 'cbi-progressbar', 'style': 'width:100%',
			           'title': has ? '%.1f%%'.format(v) : '—' },
				E('div', { 'style': 'width:%.1f%%'.format(Math.min(v, 100)) })))
	]);
}

return baseclass.extend({
	title: t('CPU usage', 'CPU 占用'),

	load: function() {
		return collect();
	},

	render: function(s) {
		if (!s)
			return E('em', {}, t('Collecting data…', '正在采集数据…'));

		var table = E('table', { 'class': 'table' });

		table.appendChild(renderRow(t('Total', '总计'), s.usage['cpu']));
		table.appendChild(renderRow('cpu0', s.usage['cpu0']));
		table.appendChild(renderRow('cpu1', s.usage['cpu1']));

		return table;
	}
});
