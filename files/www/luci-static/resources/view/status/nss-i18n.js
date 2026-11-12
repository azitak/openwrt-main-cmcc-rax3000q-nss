'use strict';
'require baseclass';

/* LuCI 把界面语言写在 <html lang="..."> 上（argon 主题 head.ut：
 * <html lang="{{ dispatcher.lang }}">），语言码形如 zh_cn / zh-cn。
 * 本项目的状态卡只提供简体中文译文，其它语言一律回退英文原文。
 *
 * 这个文件不能放进 view/status/include/：LuCI 的状态页把该目录下的每个
 * .js 都当成一张卡片加载（luci-mod-status 的 view/status/index.js），
 * 多放一个文件就会多出一张空卡片。 */
var ZH = /^(zh[-_]cn|zh[-_]hans)([-_]|$)/i.test(String(document.documentElement.lang || ''));

return baseclass.extend({
	zh: ZH,
	t: function(en, zh) { return ZH ? zh : en; }
});
