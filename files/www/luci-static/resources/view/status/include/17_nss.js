'use strict';
'require baseclass';
'require fs';

/* 默认英语；界面语言为中文时显示中文 */
var ZH = String(document.documentElement.lang || '').toLowerCase().indexOf('zh') === 0;
function t(en, zh) { return ZH ? zh : en; }

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
	return L.resolveDefault(fs.read('/sys/kernel/debug/qca-nss-drv/stats/ipv4'), '').then(parseStats);
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

function build(r, next4, ms) {
	var status = r[0] || '';
	/* 第二次采样失败时绝对计数退回首次采样：吞吐行按 '?' 显示，其余行保持 */
	var ipv4 = (next4.ipv4_rx_pkts != null) ? next4 : r[3];
	var ipv6 = parseStats(r[4]);
	var rates = diffRates(r[3], next4, ms);

	/* "Min \t Avg \t Max" 一行三个百分比 */
	var lm = (r[5] || '').match(/(\d+)\s*%\s+(\d+)\s*%\s+(\d+)\s*%/);
	var load = lm ? { min: parseInt(lm[1], 10), avg: parseInt(lm[2], 10), max: parseInt(lm[3], 10) } : null;

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
		conns: parseCount(r[1]),
		accel: parseCount(r[2]),
		ipv4: ipv4,
		ipv6: ipv6,
		drops: (ipv4.ipv4_rx_pkts != null) ? drops : null,
		rates: rates,
		load: load
	};
}

/* 官方卡片均为无状态设计：index.js 每个轮询周期都重新调用 load()，
 * render() 是 load() 数据的纯函数。吞吐由 ipv4 统计两次采样差分而来，
 * 因此把完整测量窗封闭在单次 load() 内，不保留任何跨周期基线——
 * 刷新、解除隐藏、跳页返回、后台切回，首帧均为当次实测的吞吐。 */
function measure() {
	return Promise.all([
		L.resolveDefault(fs.read('/sys/kernel/debug/qca-dwmac-nss/status'), ''),
		L.resolveDefault(fs.read('/sys/kernel/debug/ecm/ecm_db/connection_count'), ''),
		L.resolveDefault(fs.read('/sys/kernel/debug/ecm/ecm_nss_ipv4/accelerated_count'), ''),
		readIpv4(),
		L.resolveDefault(fs.read('/sys/kernel/debug/qca-nss-drv/stats/ipv6'), ''),
		L.resolveDefault(fs.read('/sys/kernel/debug/qca-nss-drv/stats/cpu_load_ubi'), '')
	]).then(function(r) {
		var t0 = Date.now();

		return new Promise(function(resolve) {
			setTimeout(function() {
				readIpv4().then(function(next4) {
					resolve(build(r, next4, Date.now() - t0));
				});
			}, 1000);
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
