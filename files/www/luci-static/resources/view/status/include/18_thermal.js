'use strict';
'require baseclass';
'require fs';

/* 默认英语；界面语言为中文时显示中文 */
var ZH = String(document.documentElement.lang || '').toLowerCase().indexOf('zh') === 0;
function t(en, zh) { return ZH ? zh : en; }

/* rpcd 的 ACL 按 realpath 匹配：/sys/class/thermal/*、/sys/class/hwmon/* 是
 * 符号链接，这里直接读 /sys/devices/... 的真实路径。
 * hwmon0-3 与 thermal zone 是同一批 SoC 传感器（重复），
 * hwmon4/5 是 ath11k 的两路 Wi-Fi 温度。 */
var ZONES = 4;
var ZBASE = '/sys/devices/virtual/thermal/thermal_zone';
var HWMONS = [
	'/sys/devices/virtual/thermal/thermal_zone0/hwmon0',
	'/sys/devices/virtual/thermal/thermal_zone1/hwmon1',
	'/sys/devices/virtual/thermal/thermal_zone2/hwmon2',
	'/sys/devices/virtual/thermal/thermal_zone3/hwmon3',
	'/sys/devices/platform/soc@0/c000000.wifi/ieee80211/phy0/hwmon4',
	'/sys/devices/platform/soc@0/b00a040.wifi/ieee80211/phy1/hwmon5'
];

return baseclass.extend({
	title: t('Temperature', '温度'),

	load: function() {
		var tasks = [];

		for (var i = 0; i < ZONES; i++) {
			tasks.push(L.resolveDefault(fs.read(ZBASE + i + '/type'), ''));
			tasks.push(L.resolveDefault(fs.read(ZBASE + i + '/temp'), ''));
		}

		for (var h = 0; h < HWMONS.length; h++) {
			tasks.push(L.resolveDefault(fs.read(HWMONS[h] + '/name'), ''));
			tasks.push(L.resolveDefault(fs.read(HWMONS[h] + '/temp1_input'), ''));
		}

		return Promise.all(tasks).then(function(r) {
			var list = [], wifi = 0;

			for (var i = 0; i < ZONES; i++) {
				var type = (r[i * 2] || '').trim();
				var temp = parseInt(r[i * 2 + 1], 10);

				if (type && !isNaN(temp))
					list.push({ name: type, temp: temp / 1000 });
			}

			for (var h = 0; h < HWMONS.length; h++) {
				var name = (r[ZONES * 2 + h * 2] || '').trim();
				var t2 = parseInt(r[ZONES * 2 + h * 2 + 1], 10);

				if (name === 'ath11k_hwmon' && !isNaN(t2))
					list.push({ name: 'Wi-Fi ' + (++wifi), temp: t2 / 1000 });
			}

			return list;
		});
	},

	render: function(list) {
		if (!list || !list.length)
			return E('em', {}, t('No sensors found', '未发现温度传感器'));

		var table = E('table', { 'class': 'table' });

		list.forEach(function(s) {
			var hot = s.temp >= 75;

			table.appendChild(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'width': '50%' }, s.name),
				E('td', { 'class': 'td left', 'style': hot ? 'color:#d00;font-weight:bold' : '' },
				  '%.1f °C'.format(s.temp))
			]));
		});

		return table;
	}
});
