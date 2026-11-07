'use strict';
'require baseclass';
'require rpc';

/* 默认英语；界面语言为中文时显示中文 */
var ZH = String(document.documentElement.lang || '').toLowerCase().indexOf('zh') === 0;
function t(en, zh) { return ZH ? zh : en; }

/* 通过 ubus network.device status 取接口统计 ——
 * 与 LuCI 自带“端口状态”页同源，且在 NSS 卸载下可用；
 * 不读 /proc/net/dev（它经 /proc/self 符号链接，rpcd 的 file ACL 按
 * realpath 校验，无法稳定授权）。 */
var callDevStatus = rpc.declare({
	object: 'network.device',
	method: 'status',
	params: [ 'name' ],
	expect: { '': {} }
});

var IFACES = [
	[ 'wan', 'WAN' ],
	[ 'lan1', 'LAN1' ],
	[ 'lan2', 'LAN2' ],
	[ 'lan3', 'LAN3' ],
	[ 'br-lan', t('LAN bridge', 'LAN 网桥') ],
	[ 'phy0-ap0', 'Wi-Fi 2.4G' ],
	[ 'phy1-ap0', 'Wi-Fi 5G' ]
];

var prev = null;

function sample() {
	return Promise.all(IFACES.map(function(def) {
		return L.resolveDefault(callDevStatus(def[0]), {}).then(function(st) {
			var s = (st && st.statistics) ? st.statistics : null;

			return {
				name: def[0],
				c: s ? { rx: Number(s.rx_bytes) || 0,
				         tx: Number(s.tx_bytes) || 0 } : null
			};
		});
	})).then(function(rows) {
		var out = {};

		rows.forEach(function(r) {
			if (r.c)
				out[r.name] = r.c;
		});

		return out;
	});
}

function fmtRate(bps) {
	if (bps == null || isNaN(bps))
		return '—';
	if (bps >= 1e6)
		return (bps / 1e6).toFixed(2) + ' Mbit/s';
	if (bps >= 1e3)
		return (bps / 1e3).toFixed(1) + ' kbit/s';
	return bps.toFixed(0) + ' bit/s';
}

function diff(cur, next, millis) {
	var out = {};

	IFACES.forEach(function(def) {
		var name = def[0];

		if (!cur[name] || !next[name] || millis <= 0)
			return;

		var dRx = next[name].rx - cur[name].rx;
		var dTx = next[name].tx - cur[name].tx;

		if (dRx >= 0 && dTx >= 0)
			out[name] = {
				rx: dRx * 8 / millis * 1000,
				tx: dTx * 8 / millis * 1000
			};
	});

	return out;
}

function collect() {
	return sample().then(function(cur) {
		if (prev) {
			var millis = Date.now() - prev.t;
			var old = prev.counters;

			prev = { t: Date.now(), counters: cur };

			return { counters: cur, rates: diff(old, cur, millis) };
		}

		/* 首轮：等 1 s 再采一次，立刻给出初始读数 */
		return new Promise(function(resolve) {
			setTimeout(function() {
				sample().then(function(next) {
					prev = { t: Date.now(), counters: next };
					resolve({ counters: next, rates: diff(cur, next, 1000) });
				});
			}, 1000);
		});
	});
}

return baseclass.extend({
	title: t('Network speed', '网络速度'),

	load: function() {
		return collect();
	},

	render: function(s) {
		if (!s)
			return E('em', {}, t('Collecting data…', '正在采集数据…'));

		var table = E('table', { 'class': 'table' });

		table.appendChild(E('tr', { 'class': 'tr' }, [
			E('th', { 'class': 'th left', 'width': '40%' }, t('Interface', '接口')),
			E('th', { 'class': 'th left' }, t('Download', '下载')),
			E('th', { 'class': 'th left' }, t('Upload', '上传'))
		]));

		IFACES.forEach(function(def) {
			var r = s.rates ? s.rates[def[0]] : null;

			table.appendChild(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left' }, def[1]),
				E('td', { 'class': 'td left' }, r ? fmtRate(r.rx) : '—'),
				E('td', { 'class': 'td left' }, r ? fmtRate(r.tx) : '—')
			]));
		});

		return table;
	}
});
