/*!
 * liquid-glass.js — 把页面上的指定元素变成"真·液态玻璃"
 *
 * 用 SVG 位移贴图做真实折射，参数取自液态玻璃演示里调好的那一组：
 *   玻璃厚度 32 · 边框宽度 30 · 折射率 2.05 · 缩放比例 2.2
 *   模糊 0.0 · 高光不透明度 0.00 · 高光饱和度 4 · 色调 #000 45%
 *
 * 调参之前先读这段（三个参数曾经把效果调成"完全看不见"）：
 *   · 折射是差分效应。位移贴图只能弯折背景里**本来就存在的边缘**；
 *     背景是纯色或大半径渐变时，位移它等于没位移。所以 liquid-glass.css
 *     给卡片垫了一层 14px 细网格（.portals / .people / .contact-grid::before）。
 *   · 模糊是折射的天敌。feGaussianBlur 在 feDisplacementMap **之前**执行，
 *     blur=10 会把网格糊成均值，位移再准也看不出来（整块退化成奶白）。
 *   · 厚度决定位移量（峰值 ≈ 厚度 × 1.9）。30 给到 57px 的位移，
 *     对着 19px 的圆角就是"从卡片外 3 倍距离处采样"，像拉扯不像镜片。
 *
 * 做法与演示页一致：为每个元素按它自己的尺寸 / 圆角生成两张贴图
 * （位移 + 高光），再写进一条独立的 <filter>，最后由 backdrop-filter 引用。
 * 尺寸变化时（ResizeObserver）重新生成，保证折射始终贴合边缘。
 *
 * 仅 Chromium 支持 backdrop-filter 引用 SVG 滤镜；其它浏览器保留 CSS 里
 * 预先写好的毛玻璃降级（见 assets/css/liquid-glass.css）。
 */
(function (window, document) {
    'use strict';

    var SVG_NS = 'http://www.w3.org/2000/svg';

    /* ---- 调色板 / 参数：想微调就改这里 -------------------------------- */
    var CFG = {
        thickness: 32,          // 玻璃厚度（峰值位移 ≈ 厚度 × 1.9）
        bezel: 30,              // 边框宽度（折射带宽度）
        ior: 2.05,              // 折射率
        scaleRatio: 2.2,        // 缩放比例
        /* 模糊：0 = 完全不糊。它在位移之前执行，会先把背景细节抹掉，
           折射也就没得折了 —— 这也是"调暗"必须由 tint 负责、不能靠模糊兜的原因。 */
        blur: 0,
        specOpacity: 0,         // 高光不透明度（改用 CSS 反光，省掉一整层滤镜）
        specSaturation: 4,      // 高光饱和度
        /* 色调：从"12% 白"换成"45% 黑"。白 tint 是把卡片往上提亮，
           在这张暗页面上就成了"蒙一层白纸"；黑 tint 才让玻璃沉下去，
           而且卡片越暗，被弯折的亮底纹对比越强，折射反而更清楚。 */
        tintColor: '#000000',   // 色调
        tintOpacity: 0.45,      // 色调不透明度（近黑底上 6% 几乎看不出面）
        /* 哪些元素变成玻璃 */
        selectors: ['.site-head', '.portal', '.dossier', '.person', '.panel', '.btn', '.burger', '.to-top'],
        /* 其中的例外：白色主按钮保持实心，CTA 的层级不能被玻璃吃掉 */
        exclude: '.btn.solid, .btn-cta',
        /* 面积上限（px²）：设为 Infinity = 所有元素都用 SVG 折射，
           连 1180px 宽的通缉令面板也走真折射（代价是那一段滚动约 40fps）。
           想给大面板退回轻磨砂，把它改回 260000。 */
        maxArea: Infinity
    };

    /* ---- 曲面高度函数：凸面超椭圆（演示页默认） ------------------------ */
    function surfaceHeight(x) {
        return Math.pow(1 - Math.pow(1 - x, 4), 0.25);
    }

    /* ---- 由曲面 + 厚度 / 边框 / 折射率算出折射剖面 ---------------------- */
    function refractionProfile(glassThickness, bezelWidth, heightFn, ior, samples) {
        samples = samples || 128;
        var eta = 1 / ior;
        function refract(nx, ny) {
            var dot = ny;
            var k = 1 - eta * eta * (1 - dot * dot);
            if (k < 0) return null;
            var sq = Math.sqrt(k);
            return [-(eta * dot + sq) * nx, eta - (eta * dot + sq) * ny];
        }
        var profile = new Float64Array(samples);
        for (var i = 0; i < samples; i++) {
            var x = i / samples;
            var y = heightFn(x);
            var dx = x < 1 ? 0.0001 : -0.0001;
            var y2 = heightFn(x + dx);
            var deriv = (y2 - y) / dx;
            var mag = Math.sqrt(deriv * deriv + 1);
            var ref = refract(-deriv / mag, -1 / mag);
            if (!ref) { profile[i] = 0; continue; }
            profile[i] = ref[0] * ((y * bezelWidth + glassThickness) / ref[1]);
        }
        return profile;
    }

    /* ---- 位移贴图：R/G 通道 = 水平 / 垂直位移 -------------------------- */
    function displacementMap(w, h, radius, bezelWidth, profile, maxDisp) {
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        var ctx = c.getContext('2d');
        var img = ctx.createImageData(w, h);
        var d = img.data;
        for (var i = 0; i < d.length; i += 4) {
            d[i] = 128; d[i + 1] = 128; d[i + 2] = 0; d[i + 3] = 255;
        }

        var r = radius, rSq = r * r, r1Sq = (r + 1) * (r + 1);
        var rBSq = Math.max(r - bezelWidth, 0) * Math.max(r - bezelWidth, 0);
        var wB = w - r * 2, hB = h - r * 2, S = profile.length;

        for (var y1 = 0; y1 < h; y1++) {
            for (var x1 = 0; x1 < w; x1++) {
                var x = x1 < r ? x1 - r : (x1 >= w - r ? x1 - r - wB : 0);
                var y = y1 < r ? y1 - r : (y1 >= h - r ? y1 - r - hB : 0);
                var dSq = x * x + y * y;
                if (dSq > r1Sq || dSq < rBSq) continue;
                var dist = Math.sqrt(dSq);
                var fromSide = r - dist;
                var op = dSq < rSq ? 1 : 1 - (dist - Math.sqrt(rSq)) / (Math.sqrt(r1Sq) - Math.sqrt(rSq));
                if (op <= 0 || dist === 0) continue;
                var cos = x / dist, sin = y / dist;
                var bi = Math.min(((fromSide / bezelWidth) * S) | 0, S - 1);
                var disp = profile[bi] || 0;
                var dX = (-cos * disp) / maxDisp;
                var dY = (-sin * disp) / maxDisp;
                var idx = (y1 * w + x1) * 4;
                d[idx] = (128 + dX * 127 * op + 0.5) | 0;
                d[idx + 1] = (128 + dY * 127 * op + 0.5) | 0;
            }
        }
        ctx.putImageData(img, 0, 0);
        return c.toDataURL();
    }

    /* ---- 高光贴图（高光不透明度 > 0 时才生成） ------------------------- */
    function specularMap(w, h, radius, bezelWidth, angle) {
        angle = angle != null ? angle : Math.PI / 3;
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        var ctx = c.getContext('2d');
        var img = ctx.createImageData(w, h);
        var d = img.data;
        var r = radius, rSq = r * r, r1Sq = (r + 1) * (r + 1);
        var rBSq = Math.max(r - bezelWidth, 0) * Math.max(r - bezelWidth, 0);
        var wB = w - r * 2, hB = h - r * 2;
        var sv = [Math.cos(angle), Math.sin(angle)];

        for (var y1 = 0; y1 < h; y1++) {
            for (var x1 = 0; x1 < w; x1++) {
                var x = x1 < r ? x1 - r : (x1 >= w - r ? x1 - r - wB : 0);
                var y = y1 < r ? y1 - r : (y1 >= h - r ? y1 - r - hB : 0);
                var dSq = x * x + y * y;
                if (dSq > r1Sq || dSq < rBSq) continue;
                var dist = Math.sqrt(dSq);
                var fromSide = r - dist;
                var op = dSq < rSq ? 1 : 1 - (dist - Math.sqrt(rSq)) / (Math.sqrt(r1Sq) - Math.sqrt(rSq));
                if (op <= 0 || dist === 0) continue;
                var cos = x / dist, sin = -y / dist;
                var dot = Math.abs(cos * sv[0] + sin * sv[1]);
                var edge = Math.sqrt(Math.max(0, 1 - (1 - fromSide) * (1 - fromSide)));
                var coeff = dot * edge;
                var col = (255 * coeff) | 0;
                var alpha = (col * coeff * op) | 0;
                var idx = (y1 * w + x1) * 4;
                d[idx] = col; d[idx + 1] = col; d[idx + 2] = col; d[idx + 3] = alpha;
            }
        }
        ctx.putImageData(img, 0, 0);
        return c.toDataURL();
    }

    /* ---- 组装 <filter> ------------------------------------------------- */
    function filterMarkup(id, w, h, dispUrl, specUrl, scale) {
        /* blur = 0 时整条 primitive 都不写：留着 stdDeviation="0" 也能跑，
           但每帧要白做一次全尺寸卷积，还多一层中间 buffer。 */
        var blurOn = CFG.blur > 0;
        var src = blurOn ? 'blurred_source' : 'SourceGraphic';
        var head =
            '<filter id="' + id + '" x="0%" y="0%" width="100%" height="100%">\n' +
            (blurOn
                ? '      <feGaussianBlur in="SourceGraphic" stdDeviation="' + CFG.blur + '" result="blurred_source" />\n'
                : '') +
            '      <feImage href="' + dispUrl + '" x="0" y="0" width="' + w + '" height="' + h + '" result="disp_map" />\n' +
            '      <feDisplacementMap in="' + src + '" in2="disp_map" scale="' + scale +
            '" xChannelSelector="R" yChannelSelector="G" result="displaced" />\n' +
            '      <feColorMatrix in="displaced" type="saturate" values="' + CFG.specSaturation + '" result="displaced_sat" />\n';

        if (!specUrl) return head + '    </filter>';

        return head +
            '      <feImage href="' + specUrl + '" x="0" y="0" width="' + w + '" height="' + h + '" result="spec_layer" />\n' +
            '      <feComposite in="displaced_sat" in2="spec_layer" operator="in" result="spec_masked" />\n' +
            '      <feComponentTransfer in="spec_layer" result="spec_faded">\n' +
            '        <feFuncA type="linear" slope="' + CFG.specOpacity + '" />\n' +
            '      </feComponentTransfer>\n' +
            '      <feBlend in="spec_masked" in2="displaced" mode="normal" result="with_sat" />\n' +
            '      <feBlend in="spec_faded" in2="with_sat" mode="normal" />\n' +
            '    </filter>';
    }

    /* ---- 运行时状态 ----------------------------------------------------- */
    var uid = 0;
    var defs = null;
    var items = [];
    var timer = 0;
    var started = false;

    /* backdrop-filter 引用 SVG 滤镜只有 Chromium 会渲染；其它浏览器保留
       CSS 里的毛玻璃降级，也不必白算一遍贴图。 */
    var SUPPORTED = (function () {
        var uad = navigator.userAgentData;
        if (uad && uad.brands && uad.brands.length) {
            return uad.brands.some(function (b) { return /Chromium/i.test(b.brand); });
        }
        return /Chrome\/|Chromium\//.test(navigator.userAgent) && !/OPR\/|Opera/.test(navigator.userAgent);
    })();

    /* 连 backdrop-filter 都不支持的浏览器（老内核 / 被裁掉的定制内核）：
       磨砂也没得用，只能给一块更像玻璃的实心面，别让它半透明地糊在背景上 */
    var HAS_BACKDROP = !!(window.CSS && CSS.supports && (
        CSS.supports('backdrop-filter', 'blur(1px)') ||
        CSS.supports('-webkit-backdrop-filter', 'blur(1px)')
    ));

    /* 系统层面关掉了透明效果（Windows「透明效果」/ macOS「降低透明度」）：
       这种人要的是可读性，不是玻璃。连贴图都别生成 —— 27 个 canvas 白跑。 */
    var REDUCED_TRANSPARENCY = !!(window.matchMedia &&
        window.matchMedia('(prefers-reduced-transparency: reduce)').matches);

    /* 调试开关：?lg=frost / ?lg=solid */
    var FORCE = (location.search.match(/[?&]lg=([a-z]+)/) || [])[1] || '';

    function ensureDefs() {
        if (defs) return defs;
        var svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('id', 'lg-defs');
        svg.setAttribute('width', '0');
        svg.setAttribute('height', '0');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('color-interpolation-filters', 'sRGB');
        svg.style.cssText = 'position:absolute;overflow:hidden;pointer-events:none;width:0;height:0';
        defs = document.createElementNS(SVG_NS, 'defs');
        svg.appendChild(defs);
        document.body.appendChild(svg);
        return defs;
    }

    /* ---- 每个元素一条规则，值里写"字面量" url() -------------------------
       关键：不能把 url() 放进 CSS 变量。变量要等到"计算值"阶段才校验，
       浏览器不认识 url(#f) 时会把整条声明变成 unset —— 连 .lg-glass 里的
       磨砂降级一起丢掉，卡片就成了一块没有玻璃感的底色（也就是"失效"）。
       直接写 url(#f) 则是解析期校验：不认这条语法就直接丢弃这条规则，
       回退到 .lg-glass 自带的 blur()，至少还是一块磨砂玻璃。 */
    var ruleStyle = null;
    var ruleMap = {};

    function filterValue(el, id) {
        var url = 'url(#' + id + ')';
        /* 导航条压字，多叠一层 8px 模糊；其余元素保持纯折射 */
        if (el.classList.contains('site-head')) return 'blur(8px) ' + url + ' saturate(150%)';
        return url;
    }

    function setRule(id, value) {
        ensureRuleStyle();
        ruleMap[id] = value;
        var out = [];
        for (var k in ruleMap) {
            if (!Object.prototype.hasOwnProperty.call(ruleMap, k)) continue;
            out.push(
                'body .lg-glass[data-lg="' + k + '"]{' +
                '-webkit-backdrop-filter:' + ruleMap[k] + ';' +
                'backdrop-filter:' + ruleMap[k] + '}'
            );
        }
        ruleStyle.textContent = out.join('\n');
    }

    function ensureRuleStyle() {
        if (ruleStyle && ruleStyle.parentNode) return ruleStyle;
        ruleStyle = document.createElement('style');
        ruleStyle.id = 'lg-rules';
        (document.head || document.documentElement).appendChild(ruleStyle);
        return ruleStyle;
    }

    function cssRadius(el, w, h) {
        var cs = getComputedStyle(el);
        var r = Math.max(
            parseFloat(cs.borderTopLeftRadius) || 0,
            parseFloat(cs.borderTopRightRadius) || 0,
            parseFloat(cs.borderBottomLeftRadius) || 0,
            parseFloat(cs.borderBottomRightRadius) || 0
        );
        return Math.max(0, Math.min(r, w / 2, h / 2));
    }

    function build(item) {
        var el = item.el;
        var w = Math.round(el.offsetWidth);
        var h = Math.round(el.offsetHeight);
        if (w < 12 || h < 12) return;

        var radius = Math.round(cssRadius(el, w, h));
        if (w === item.w && h === item.h && radius === item.r) return;
        item.w = w; item.h = h; item.r = radius;

        var bezel = Math.max(1, Math.min(CFG.bezel, radius - 1, Math.min(w, h) / 2 - 1));
        var profile = refractionProfile(CFG.thickness, bezel, surfaceHeight, CFG.ior, 128);
        var maxDisp = 1;
        for (var i = 0; i < profile.length; i++) {
            var v = Math.abs(profile[i]);
            if (v > maxDisp) maxDisp = v;
        }
        var scale = +(maxDisp * CFG.scaleRatio).toFixed(2);
        var dispUrl = displacementMap(w, h, radius, bezel, profile, maxDisp);
        var specUrl = CFG.specOpacity > 0 ? specularMap(w, h, radius, bezel * 2.5) : '';

        var old = document.getElementById(item.id);
        if (old && old.parentNode) old.parentNode.removeChild(old);

        ensureDefs().insertAdjacentHTML(
            'beforeend',
            filterMarkup(item.id, w, h, dispUrl, specUrl, scale)
        );

        item.debug = { w: w, h: h, r: radius, bezel: +bezel.toFixed(1), scale: scale, mapBytes: dispUrl.length };

        el.setAttribute('data-lg', item.id);
        setRule(item.id, filterValue(el, item.id));
    }

    /* ---- 逐帧空闲时生成，避免首屏被一堆 canvas 卡住（启动动画还在跑） ---- */
    var queue = [];
    var idleScheduled = false;

    function drainOne() {
        idleScheduled = false;
        var item = queue.shift();
        if (item) build(item);
        if (queue.length) scheduleIdle();
    }

    function scheduleIdle() {
        if (idleScheduled || !queue.length) return;
        idleScheduled = true;
        if (window.requestIdleCallback) {
            window.requestIdleCallback(drainOne, { timeout: 200 });
        } else {
            setTimeout(drainOne, 16);
        }
    }

    function enqueue(item) {
        if (queue.indexOf(item) === -1) queue.push(item);
        scheduleIdle();
    }

    function buildAll() {
        items.forEach(enqueue);
    }

    function schedule() {
        clearTimeout(timer);
        timer = setTimeout(buildAll, 140);
    }

    function attach(el) {
        if (!el || el.__lgAttached) return;
        el.__lgAttached = true;

        /* 降低透明度：直接不挂玻璃面，保留页面自己的实体底色即可。
           CSS 里那条 @media 只是兜底，这里从源头省掉全部贴图生成。 */
        if (REDUCED_TRANSPARENCY) return;

        el.classList.add('lg-glass');
        el.style.setProperty('--lg-tint', hexToRgba(CFG.tintColor, CFG.tintOpacity));

        /* 调试开关：index.html?lg=frost 只保留磨砂（验证 backdrop-filter 本身是否工作）
                      index.html?lg=solid 完全不透明（验证是不是滤镜被拦截） */
        if (FORCE === 'frost') return;
        if (FORCE === 'solid') {
            el.classList.add('lg-solid');
            return;
        }

        if (!HAS_BACKDROP) {
            /* 连磨砂都做不了：给一块不透明的玻璃面，别半透明地糊在背景上 */
            el.classList.add('lg-solid');
            return;
        }
        if (!SUPPORTED) return;
        /* 超过面积上限的面只保留毛玻璃降级，不再进队列/监听尺寸 */
        if (el.offsetWidth * el.offsetHeight > CFG.maxArea) {
            el.classList.add('lg-frost');
            return;
        }

        var item = { el: el, id: 'lg-f' + (++uid), w: 0, h: 0, r: 0 };
        items.push(item);
        enqueue(item);

        if (window.ResizeObserver) {
            var ro = new ResizeObserver(function () { schedule(); });
            ro.observe(el);
        }
    }

    function hexToRgba(hex, a) {
        var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
        var r = m ? parseInt(m[1], 16) : 255;
        var g = m ? parseInt(m[2], 16) : 255;
        var b = m ? parseInt(m[3], 16) : 255;
        return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')';
    }

    function scan() {
        var els = document.querySelectorAll(CFG.selectors.join(','));
        for (var i = 0; i < els.length; i++) {
            if (CFG.exclude && els[i].matches(CFG.exclude)) continue;
            attach(els[i]);
        }
    }

    function start() {
        if (started) return;
        started = true;
        scan();
        window.addEventListener('resize', schedule);
        window.addEventListener('orientationchange', schedule);
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(schedule);
        }
        /* 卡片里的头像是异步加载的，图片落位后高度会变一次 */
        window.addEventListener('load', schedule);

        /* 一行自检：出问题时把控制台这行发出来就能定位——
           appliedCard 是 url(...) 说明规则生效；card 里的 r / bezel / scale
           能看出贴图本身是不是正常的（r=0 或 scale≈0 就等于没有折射）。 */
        setTimeout(function () {
            var card = document.querySelector('.portal') || (items[0] && items[0].el);
            var item = null;
            for (var i = 0; i < items.length; i++) {
                if (items[i].el === card) { item = items[i]; break; }
            }
            var f = document.querySelector('#lg-defs filter');
            console.info('[liquid-glass]', {
                chromium: SUPPORTED,
                backdropFilter: HAS_BACKDROP,
                mode: FORCE || 'svg',
                elements: items.length,
                appliedCard: card ? getComputedStyle(card).backdropFilter : '',
                card: item ? item.debug : null,
                filterNodes: document.querySelectorAll('#lg-defs filter').length,
                firstFilterBytes: f ? f.innerHTML.length : 0
            });
        }, 1200);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            requestAnimationFrame(function () { requestAnimationFrame(start); });
        });
    } else {
        start();
    }

    window.LiquidGlass = {
        config: CFG,
        refresh: function () { scan(); schedule(); },
        add: attach
    };
})(window, document);
