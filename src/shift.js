/*
 * Сдвиг картинки (защита OLED от выгорания). Раз в несколько минут всё приложение сдвигается на несколько пикселей
 * по кругу из восьми положений: статичные элементы (шапка, меню, края карточек) не стоят одним и тем же пикселем часами.
 * Глазу это не видно: шаг до 5 пикселей на экране 1920 точек раз в три минуты.
 *
 * Сдвиг делает один transform на #app через две переменные CSS (--lw-sx, --lw-sy), без переходов и без размытия.
 * Пока открыт плеер, шаг пропускается: фильм идёт поверх приложения, а скачок картинки во время просмотра не нужен.
 * Работает только вместе с новым оформлением и пока включён переключатель «Сдвиг картинки».
 */
LW.shift = (function () {
    // секунд между шагами (tick в тестах уменьшается, чтобы не ждать минуты)
    var api = { every: 180, tick: 1000 };
    // положения по кругу, пиксели (x, y): все в пределах ±5, соседние отличаются на 3-8 пикселей
    var POS = [[0, 0], [5, 3], [-4, 5], [3, -5], [-5, -3], [4, 4], [-3, -4], [5, -2]];
    var state = { on: false, i: 0, t: null };

    function set(i) {
        var p = POS[i % POS.length];
        var s = document.body.style;

        s.setProperty('--lw-sx', p[0] + 'px');
        s.setProperty('--lw-sy', p[1] + 'px');
    }

    function next() {
        clearTimeout(state.t);
        state.t = setTimeout(function () {
            if (!state.on) return;

            // идёт фильм: шаг пропускаем и пробуем через такой же срок
            if (!document.querySelector('.player')) {
                state.i = (state.i + 1) % POS.length;
                set(state.i);
            }

            next();
        }, api.every * api.tick);
    }

    function on() {
        if (state.on) return;

        state.on = true;
        document.body.classList.add('lw-shift');
        set(state.i);
        next();
    }

    function off() {
        state.on = false;
        clearTimeout(state.t);
        state.t = null;
        document.body.classList.remove('lw-shift');
        document.body.style.removeProperty('--lw-sx');
        document.body.style.removeProperty('--lw-sy');
    }

    api.on = on;
    api.off = off;
    api.step = function () { state.i = (state.i + 1) % POS.length; set(state.i); };
    api.index = function () { return state.i; };
    api.POS = POS;

    return api;
})();
