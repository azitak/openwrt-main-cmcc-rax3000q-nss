'use strict';
'require baseclass';
'require fs';

/* 默认英语；界面语言为中文时显示中文 */
var ZH = String(document.documentElement.lang || '').toLowerCase().indexOf('zh') === 0;
function t(en, zh) { return ZH ? zh : en; }

/* 跨轮询保留上次采样，用来算速率 */
var prev = null;

function parseStats(text) {
	var out = {};

	(text || '').split('\n').forEach(function(line) {
		var m = line.match(/^\s*([A-Za-z0-9_\[\]]+)\s*=\s*(\d+)/);
		if (m && !(m[1] in out))
			out[m[1]] = parseInt(m[2], 10);
	});

	return out;
}

function fmtNum(n) {
	if (n == null || isNaN(n))
		return '—';
	if (Math.abs(n) >= 1e9)
		return (n / 1e9).toFixed(2) + ' G';
	if (Math.abs(n) >= 1e6)
		return (n / 1e6).toFixed(2) + ' M';
	if (Math.abs(n) >= 1e3)
		return (n / 1e3).toFixed(1) + ' k';
	return String(n);
}

function fmtBytes(b) {
	if (b == null || isNaN(b))
		return '—';
	var u = [ 'B', 'KiB', 'MiB', 'GiB', 'TiB' ], i = 0;
	while (Math.abs(b) >= 1024 && i < u.length - 1) {
		b /= 1024;
		i++;
	}
	return b.toFixed(i ? 2 : 0) + ' ' + u[i];
}

function fmtRate(bps) {
	if (bps == null || isNaN(bps))
		return '—';
	if (bps >= 1e6)
		return (bps / 1e6).toFixed(1) + ' Mbit/s';
	if (bps >= 1e3)
		return (bps / 1e3).toFixed(1) + ' kbit/s';
	return bps.toFixed(0) + ' bit/s';
}

return baseclass.extend({
	title: t('NSS offload', 'NSS 卸载'),

	load: function() {
		return Promise.all([
			L.resolveDefault(fs.read('/sys/kernel/debug/qca-dwmac-nss/status'), ''),
			L.resolveDefault(fs.read('/sys/kernel/debug/ecm/ecm_db/connection_count'), ''),
			L.resolveDefault(fs.read('/sys/kernel/debug/ecm/ecm_nss_ipv4/accelerated_count'), ''),
			L.resolveDefault(fs.read('/sys/kernel/debug/qca-nss-drv/stats/ipv4'), ''),
			L.resolveDefault(fs.read('/sys/kernel/debug/qca-nss-drv/stats/ipv6'), ''),
			L.resolveDefault(fs.read('/sys/kernel/debug/qca-nss-drv/stats/cpu_load_ubi'), '')
		]).then(function(r) {
			var status = r[0] || '';
			var ipv4 = parseStats(r[3]);
			var ipv6 = parseStats(r[4]);
			var now = Date.now();
			var rates = null;
			var load = null;

			/* "Min \t Avg \t Max" 一行三个百分比 */
			var lm = (r[5] || '').match(/(\d+)\s*%\s+(\d+)\s*%\s+(\d+)\s*%/);

			if (lm)
				load = { min: parseInt(lm[1], 10), avg: parseInt(lm[2], 10), max: parseInt(lm[3], 10) };

			if (prev && ipv4.ipv4_rx_pkts != null && prev.rx != null) {
				var dt = (now - prev.t) / 1000;

				if (dt >= 1) {
					rates = {
						rx_pps: (ipv4.ipv4_rx_pkts - prev.rx) / dt,
						tx_pps: (ipv4.ipv4_tx_pkts - prev.tx) / dt,
						rx_bps: (ipv4.ipv4_rx_byts - prev.rxb) * 8 / dt,
						tx_bps: (ipv4.ipv4_tx_byts - prev.txb) * 8 / dt
					};
					if (rates.rx_pps < 0 || rates.tx_pps < 0)
						rates = null;
				}
			}

			prev = {
				t: now,
				rx: ipv4.ipv4_rx_pkts,
				tx: ipv4.ipv4_tx_pkts,
				rxb: ipv4.ipv4_rx_byts,
				txb: ipv4.ipv4_tx_byts
			};

			var st = {};
			status.split('\n').forEach(function(l) {
				var m = l.match(/^\s+tx_redirect=(\d+).*rx_fw=(\d+)/);
				if (m) {
					st.tx_redirect = parseInt(m[1], 10);
					st.rx_fw = parseInt(m[2], 10);
				}
			});

			var plane = /phys_if 1: started dev=(\S+) fw_link=up/.exec(status);
			var drops = 0;

			for (var i = 0; i < 4; i++)
				drops += ipv4['ipv4_rx_queue[' + i + ']_drops'] || 0;

			return {
				plane: plane ? plane[1] : null,
				tx_redirect: st.tx_redirect,
				rx_fw: st.rx_fw,
				conns: parseInt(r[1], 10) || 0,
				accel: parseInt(r[2], 10) || 0,
				ipv4: ipv4,
				ipv6: ipv6,
				drops: drops,
				rates: rates,
				load: load
			};
		});
	},

	render: function(s) {
		if (!s)
			return E('em', {}, t('Collecting data…', '正在采集数据…'));

		var rows = [
			[ t('Data plane', '数据面'),
			  s.plane ? t('started (%s, fw_link up)', '已启动（%s，fw_link 正常）').format(s.plane)
			          : t('not armed', '未接管') ],
			[ t('NSS core load', 'NSS 核心负载'),
			  s.load ? t('%d%% (min %d%% / max %d%%)', '%d%%（最小 %d%% / 最大 %d%%）')
			           .format(s.load.avg, s.load.min, s.load.max) : '—' ],
			[ t('NSS firmware counters', 'NSS 固件计数'),
			  t('%s redirects / %s from-fw', '%s 重定向 / %s 来自固件')
			  .format(fmtNum(s.tx_redirect), fmtNum(s.rx_fw)) ],
			[ t('ECM flows', 'ECM 连接'),
			  t('%s accelerated / %s tracked', '%s 加速 / %s 跟踪')
			  .format(fmtNum(s.accel), fmtNum(s.conns)) ],
			[ t('IPv4 RX', 'IPv4 接收'),
			  t('%s pkts, %s', '%s 包，%s')
			  .format(fmtNum(s.ipv4.ipv4_rx_pkts), fmtBytes(s.ipv4.ipv4_rx_byts)) ],
			[ t('IPv4 TX', 'IPv4 发送'),
			  t('%s pkts, %s', '%s 包，%s')
			  .format(fmtNum(s.ipv4.ipv4_tx_pkts), fmtBytes(s.ipv4.ipv4_tx_byts)) ],
			[ t('IPv4 throughput', 'IPv4 吞吐'),
			  s.rates ? '%s ↓ / %s ↑'.format(fmtRate(s.rates.rx_bps), fmtRate(s.rates.tx_bps)) : '—' ],
			[ t('IPv4 drops', 'IPv4 丢包'), fmtNum(s.drops) ],
			[ t('IPv6 RX/TX', 'IPv6 接收/发送'),
			  t('%s / %s pkts', '%s / %s 包')
			  .format(fmtNum(s.ipv6.ipv6_rx_pkts), fmtNum(s.ipv6.ipv6_tx_pkts)) ]
		];

		var table = E('table', { 'class': 'table' });

		rows.forEach(function(r) {
			table.appendChild(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'width': '34%' }, r[0]),
				E('td', { 'class': 'td left' }, r[1])
			]));
		});

		return table;
	}
});
