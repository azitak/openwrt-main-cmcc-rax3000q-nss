'use strict';
'require baseclass';
'require rpc';
'require view.status.nss-i18n as i18n';

var t = i18n.t;

/* 通过 ubus network.device status 取接口统计 ——
 * 与官方“端口状态”卡片（29_ports.js）同款调用，NSS 卸载下可用；
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

/* 速率来自两次采样的字节计数差分。基线留在模块里：上一轮的计数直接
 * 给下一轮当差分基准，load() 就不必再等一个测量窗——状态页每轮轮询
 * 都 await 全部卡片的 load()（luci-mod-status 的 view/status/index.js），
 * 在 load() 里等待会把整页刷新一起拖住。没有可用基线时（首帧、卡片
 * 被隐藏过、后台挂起）退回一次短窗实测。 */
var prev = null;
var WINDOW = 1000;    /* 实测窗口，毫秒 */
var MAX_GAP = 60000;  /* 基线超过这个间隔就作废，重新实测 */

function measure() {
	return sample().then(function(cur) {
		var now = Date.now();

		if (prev && (now - prev.ts) <= MAX_GAP) {
			var res = { counters: cur, rates: diff(prev.data, cur, now - prev.ts) };

			prev = { ts: now, data: cur };

			return res;
		}

		return new Promise(function(resolve) {
			setTimeout(function() {
				sample().then(function(next) {
					prev = { ts: Date.now(), data: next };

					resolve({ counters: next, rates: diff(cur, next, Date.now() - now) });
				});
			}, WINDOW);
		});
	});
}

function fmtRate(bps) {
	if (bps == null || isNaN(bps))
		return '?';
	if (bps >= 1e6)
		return (bps / 1e6).toFixed(2) + '\xa0Mbit/s';
	if (bps >= 1e3)
		return (bps / 1e3).toFixed(1) + '\xa0kbit/s';
	return bps.toFixed(0) + '\xa0bit/s';
}

return baseclass.extend({
	title: t('Network speed', '网络速度'),

	load: function() {
		return measure();
	},

	render: function(s) {
		/* 全部接口都取不到统计：返回 null 让上层保留上一帧 DOM */
		if (!s || !s.counters || Object.keys(s.counters).length == 0)
			return null;

		var table = E('table', { 'class': 'table' });

		table.appendChild(E('tr', { 'class': 'tr' }, [
			E('th', { 'class': 'th left', 'width': '40%' }, t('Interface', '接口')),
			E('th', { 'class': 'th left' }, t('Download', '下载')),
			E('th', { 'class': 'th left' }, t('Upload', '上传'))
		]));

		IFACES.forEach(function(def) {
			/* 设备上没有的接口不占行 */
			if (!s.counters[def[0]])
				return;

			var r = s.rates ? s.rates[def[0]] : null;

			table.appendChild(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left' }, def[1]),
				E('td', { 'class': 'td left' }, r ? fmtRate(r.rx) : '?'),
				E('td', { 'class': 'td left' }, r ? fmtRate(r.tx) : '?')
			]));
		});

		return table;
	}
});
