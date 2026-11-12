'use strict';
'require baseclass';
'require fs';
'require view.status.nss-i18n as i18n';

var t = i18n.t;

/* /sys/block/zram0 是符号链接，rpcd ACL 按 realpath 校验 */
var BASE = '/sys/devices/virtual/block/zram0';

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

return baseclass.extend({
	title: t('zram swap', 'zram 交换'),

	load: function() {
		/* fs.trimmed()/fs.lines() 读 /sys 与 /proc：不会 reject，
		 * 读不到时分别是空串和空数组 */
		return Promise.all([
			fs.trimmed(BASE + '/disksize'),
			fs.trimmed(BASE + '/mm_stat'),
			fs.lines('/proc/swaps')
		]).then(function(r) {
			var disk = parseInt(r[0], 10);
			var mm = (r[1] || '').split(/\s+/).map(Number);
			var swap = null;

			r[2].forEach(function(l) {
				var m = l.match(/^\/dev\/zram0\s+\S+\s+(\d+)\s+(\d+)/);
				if (m)
					swap = { size: parseInt(m[1], 10) * 1024, used: parseInt(m[2], 10) * 1024 };
			});

			if (!disk && (!mm.length || isNaN(mm[0])))
				return null;

			return { disk: disk || null, mm: mm, swap: swap };
		});
	},

	render: function(z) {
		if (!z)
			return E('em', {}, t('zram is not active', 'zram 未启用'));

		var mm = z.mm;
		var ratio = (mm[0] > 0 && mm[1] > 0) ? (mm[0] / mm[1]).toFixed(1) + '×' : '?';

		var rows = [
			[ t('Device size', '设备容量'), z.disk ? fmtBytes(z.disk) : '?' ],
			[ t('Original data', '原始数据'), fmtBytes(mm[0]) ],
			[ t('Compressed data', '压缩后数据'), fmtBytes(mm[1]) ],
			[ t('RAM used', '占用内存'), fmtBytes(mm[2]) ],
			[ t('Compression ratio', '压缩比'), ratio ],
			[ t('Swap in use', '交换区使用'),
			  z.swap ? '%s / %s'.format(fmtBytes(z.swap.used), fmtBytes(z.swap.size)) : '?' ]
		];

		var table = E('table', { 'class': 'table' });

		rows.forEach(function(r) {
			table.appendChild(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'width': '40%' }, r[0]),
				E('td', { 'class': 'td left' }, r[1])
			]));
		});

		return table;
	}
});
