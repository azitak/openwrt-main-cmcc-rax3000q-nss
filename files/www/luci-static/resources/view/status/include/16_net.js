'use strict';
'require baseclass';
'require rpc';

/* 默认英语；界面语言为中文时显示中文 */
var ZH = String(document.documentElement.lang || '').toLowerCase().indexOf('zh') === 0;
function t(en, zh) { return ZH ? zh : en; }

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

function fmtRate(bps) {
	if (bps == null || isNaN(bps))
		return '?';
	if (bps >= 1e6)
		return (bps / 1e6).toFixed(2) + '\xa0Mbit/s';
	if (bps >= 1e3)
		return (bps / 1e3).toFixed(1) + '\xa0kbit/s';
	return bps.toFixed(0) + '\xa0bit/s';
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

/* 官方卡片均为无状态设计：index.js 每个轮询周期都重新调用 load()，
 * render() 是 load() 数据的纯函数。速率必须由两次采样差分而来，
 * 因此把「采一次 → 等 1 s → 再采一次」的完整测量窗封闭在单次
 * load() 内，不保留任何跨周期基线——刷新、解除隐藏、跳页返回、
 * 后台切回，首帧均为当次实测的真实速率。 */
function measure() {
	var t0;

	return sample().then(function(cur) {
		t0 = Date.now();

		return new Promise(function(resolve) {
			setTimeout(function() {
				sample().then(function(next) {
					resolve({ counters: next, rates: diff(cur, next, Date.now() - t0) });
				});
			}, 1000);
		});
	});
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
