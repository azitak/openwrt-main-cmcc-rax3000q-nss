'use strict';
'require baseclass';
'require fs';
'require view.status.nss-i18n as i18n';

var t = i18n.t;

function parseStats(text) {
	var out = {};

	(text || '').split('\n').forEach(function(line) {
		var m = line.match(/^\s*([A-Za-z0-9_\[\]]+)\s*=\s*(\d+)/);

		if (m && !(m[1] in out))
			out[m[1]] = parseInt(m[2], 10);
	});

	return out;
}

/* connection_count / accelerated_count 之类单值文件：整行必须是纯数字，
 * 否则按“无数据”处理而不是 0 */
function parseCount(text) {
	var m = (text || '').match(/^\s*(\d+)\s*$/);

	return m ? parseInt(m[1], 10) : null;
}

function fmtNum(n) {
	if (n == null || isNaN(n))
		return '?';
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
		return '?';
	var u = [ 'B', 'KiB', 'MiB', 'GiB', 'TiB' ], i = 0;
	while (Math.abs(b) >= 1024 && i < u.length - 1) {
		b /= 1024;
		i++;
	}
	return b.toFixed(i ? 2 : 0) + ' ' + u[i];
}

function fmtRate(bps) {
	if (bps == null || isNaN(bps))
		return '?';
	if (bps >= 1e6)
		return (bps / 1e6).toFixed(1) + '\xa0Mbit/s';
	if (bps >= 1e3)
		return (bps / 1e3).toFixed(1) + '\xa0kbit/s';
	return bps.toFixed(0) + '\xa0bit/s';
}

/* ipv4 统计文件：绝对计数与吞吐差分都要用 */
function readIpv4() {
	/* fs.trimmed() 不会 reject，读不到时返回空串 */
	return fs.trimmed('/sys/kernel/debug/qca-nss-drv/stats/ipv4').then(parseStats);
}

/* ipv4 吞吐：两次采样差分；窗口异常或计数回退按无数据处理 */
function diffRates(old4, next4, ms) {
	if (old4.ipv4_rx_pkts == null || next4.ipv4_rx_pkts == null || ms <= 0)
		return null;

	var dt = ms / 1000;
	var rates = {
		rx_pps: (next4.ipv4_rx_pkts - old4.ipv4_rx_pkts) / dt,
		tx_pps: (next4.ipv4_tx_pkts - old4.ipv4_tx_pkts) / dt,
		rx_bps: (next4.ipv4_rx_byts - old4.ipv4_rx_byts) * 8 / dt,
		tx_bps: (next4.ipv4_tx_byts - old4.ipv4_tx_byts) * 8 / dt
	};

	return (rates.rx_pps < 0 || rates.tx_pps < 0 ||
	        rates.rx_bps < 0 || rates.tx_bps < 0) ? null : rates;
}

function build(r, old4, next4, ms) {
	var status = r[0] || '';
	/* 后一次采样失败时绝对计数退回旧采样：吞吐行按 '?' 显示，其余行保持 */
	var ipv4 = (next4.ipv4_rx_pkts != null) ? next4 : old4;
	var ipv6 = parseStats(r[4]);
	var rates = diffRates(old4, next4, ms);

	/* "Min \t Avg \t Max" 一行三个百分比 */
	var lm = (r[5] || '').match(/(\d+)\s*%\s+(\d+)\s*%\s+(\d+)\s*%/);
	var load = lm ? { min: parseInt(lm[1], 10), avg: parseInt(lm[2], 10), max: parseInt(lm[3], 10) } : null;

	var st = {};
	status.split('\n').forEach(function(l) {
		var m = l.match(/^\s*tx_redirect=(\d+).*rx_fw=(\d+)/);
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
		conns: parseCount(r[1]),
		accel: parseCount(r[2]),
		ipv4: ipv4,
		ipv6: ipv6,
		drops: (ipv4.ipv4_rx_pkts != null) ? drops : null,
		rates: rates,
		load: load
	};
}

/* 吞吐来自两次 ipv4 统计采样的差分。基线留在模块里：上一轮的计数直接
 * 给下一轮当差分基准，load() 就不必再等一个测量窗——状态页每轮轮询
 * 都 await 全部卡片的 load()（luci-mod-status 的 view/status/index.js），
 * 在 load() 里等待会把整页刷新一起拖住。没有可用基线时（首帧、卡片
 * 被隐藏过、后台挂起）退回一次短窗实测。 */
var prev4 = null;
var WINDOW = 1000;    /* 实测窗口，毫秒 */
var MAX_GAP = 60000;  /* 基线超过这个间隔就作废，重新实测 */

function measure() {
	return Promise.all([
		fs.trimmed('/sys/kernel/debug/qca-dwmac-nss/status'),
		fs.trimmed('/sys/kernel/debug/ecm/ecm_db/connection_count'),
		fs.trimmed('/sys/kernel/debug/ecm/ecm_nss_ipv4/accelerated_count'),
		readIpv4(),
		fs.trimmed('/sys/kernel/debug/qca-nss-drv/stats/ipv6'),
		fs.trimmed('/sys/kernel/debug/qca-nss-drv/stats/cpu_load_ubi')
	]).then(function(r) {
		var now = Date.now();

		if (prev4 && (now - prev4.ts) <= MAX_GAP) {
			var res = build(r, prev4.data, r[3], now - prev4.ts);

			prev4 = { ts: now, data: r[3] };

			return res;
		}

		return new Promise(function(resolve) {
			setTimeout(function() {
				readIpv4().then(function(next4) {
					prev4 = { ts: Date.now(), data: next4 };

					resolve(build(r, r[3], next4, Date.now() - now));
				});
			}, WINDOW);
		});
	});
}

return baseclass.extend({
	title: t('NSS offload', 'NSS 卸载'),

	load: function() {
		return measure();
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
			           .format(s.load.avg, s.load.min, s.load.max) : '?' ],
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
			  s.rates ? '%s ↓ / %s ↑'.format(fmtRate(s.rates.rx_bps), fmtRate(s.rates.tx_bps)) : '?' ],
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
