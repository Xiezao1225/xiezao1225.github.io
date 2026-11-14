/* ============================================================================
 * 彩蛋：每次加载有 1% 的概率，出现一张空的液态玻璃卡片跟着鼠标，外面套一个红圈。
 * ----------------------------------------------------------------------------
 * 设计约束：
 *   1. 99% 的访问里这段代码必须"一行副作用都不产生"：不建 DOM、不监听事件、
 *      不起 rAF。所以随机数判断放在最前面，早于一切。
 *   2. 触屏设备不出现：没有指针可跟，只会白白盖住内容。
 *   3. 只在指针真正移动时跑 rAF，停稳就退出循环 —— 不常驻一个每帧回调，
 *      因为这张卡带 backdrop-filter，动一次就要重采样一次。
 *   4. 玻璃本身交给现有管线：LiquidGlass.add() 负责加 .lg-glass、量尺寸、
 *      生成位移贴图。这里不重复实现任何视觉参数。
 *
 * 调试：?egg=1 强制出现，?egg=0 强制不出现（不用刷新一百次）。
 * ==========================================================================*/
(function () {
    "use strict";

    var CHANCE = 0.01;
    var forced = (location.search.match(/[?&]egg=(\d)/) || [])[1];
    var show = forced ? forced === "1" : Math.random() < CHANCE;
    if (!show) return;

    /* 触屏没有"鼠标"，直接不出 */
    if (!window.matchMedia || !window.matchMedia("(hover:hover) and (pointer:fine)").matches) return;

    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var EASE = 0.2;      /* 跟随阻尼：1 = 贴身，0.1 = 拖尾 */

    function build() {
        var wrap = document.createElement("div");
        wrap.className = "egg-cursor";
        wrap.setAttribute("aria-hidden", "true");
        wrap.innerHTML =
            '<span class="egg-cursor-ring"></span>' +
            '<span class="egg-cursor-card"></span>' +
            '<span class="egg-cursor-text">注意看我的液态玻璃。</span>';
        document.body.appendChild(wrap);

        var card = wrap.querySelector(".egg-cursor-card");
        var text = wrap.querySelector(".egg-cursor-text");

        /* 交给液态玻璃：等一帧，让卡片有实际尺寸再量 */
        requestAnimationFrame(function () {
            if (window.LiquidGlass && window.LiquidGlass.add) window.LiquidGlass.add(card);
            /* 这张卡浮在内容之上、离眼睛更近，所以比页面里那批卡片透亮：
               统一用的 45% 黑会让它变成一块黑斑，红圈就成了唯一的东西。 */
            card.style.setProperty("--lg-tint", "rgba(255, 255, 255, .07)");
        });

        var x = window.innerWidth / 2;
        var y = window.innerHeight / 2;
        var tx = x;
        var ty = y;
        var running = false;
        /* 文案宽度：已经插进 DOM 了，量一次就够，用来判断该不该翻到左边 */
        var textW = text.getBoundingClientRect().width || 200;

        function place() {
            wrap.style.transform = "translate3d(" + x.toFixed(1) + "px," + y.toFixed(1) + "px,0)";
            /* 指针靠近右边缘时把文案翻到红圈左边，否则会被视口切掉 */
            var flip = x + 66 + textW > window.innerWidth - 16;
            if (flip !== wrap.classList.contains("flip")) wrap.classList.toggle("flip", flip);
        }

        function tick() {
            var dx = tx - x;
            var dy = ty - y;
            if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
                x = tx; y = ty; place();
                running = false;          /* 停稳即退出，不常驻 */
                return;
            }
            x += dx * EASE;
            y += dy * EASE;
            place();
            requestAnimationFrame(tick);
        }

        window.addEventListener("pointermove", function (e) {
            tx = e.clientX;
            ty = e.clientY;
            if (reduce) {                 /* 减少动态效果：不做拖尾，直接贴合 */
                x = tx; y = ty; place();
                return;
            }
            if (!running) {
                running = true;
                requestAnimationFrame(tick);
            }
        }, { passive: true });

        place();
        try { console.log("%c[egg] 1% · 液态玻璃小卡片已出现", "color:#ff2d55"); } catch (e) {}
    }

    if (document.body) build();
    else document.addEventListener("DOMContentLoaded", build);
})();
