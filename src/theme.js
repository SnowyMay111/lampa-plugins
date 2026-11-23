/*
 * Оформление: графитовый фон, светлая выбранная кнопка как в Apple TV, без blur и тяжёлых теней.
 *
 * Тема лежит поверх настоящей разметки Лампы и включается классом body.lw-theme.
 * Сам CSS живёт в src/theme.css и при сборке вшивается сюда строкой.
 * Выпускается как бета: по умолчанию выключено, включается в Настройки → Lampa Watch.
 *
 * Страховка: если Лампа с оформлением не дожила до 8 секунд три раза подряд,
 * оформление выключается само, и Лампа работает как раньше.
 *
 * Защита OLED: через N секунд без нажатий плитки приглушаются, через 10 с прячется верхняя строка.
 */
LW.theme = (function () {
    var CSS = '__THEME_CSS__';

    var K = { on: 'lw_theme', accent: 'lw_theme_accent', idle: 'lw_theme_idle', fails: 'lw_theme_fails' };
    var STYLE_ID = 'lw-theme-css';
    var MAX_FAILS = 3;     // столько запусков подряд, не дожив до OK_AFTER, выключают оформление
    var OK_AFTER = 8;      // секунд: после этого запуск считается удачным
    var HIDE_BAR = 10;     // секунд до скрытия верхней строки

    var TXT = {
        title: 'Оформление',
        on: 'Новое оформление (бета)',
        onDescr: 'Тёмный графитовый вид в стиле Apple TV для всего приложения. По умолчанию выключено. Если Лампа три раза подряд не запустится с ним, оформление выключится само.',
        accent: 'Цвет акцента',
        blue: 'Синий',
        lime: 'Лайм',
        idle: 'Защита от выгорания',
        idle60: 'Через 60 секунд',
        idle30: 'Через 30 секунд',
        idleOff: 'Выключена',
        idleDescr: 'Когда долго нет нажатий, плитки приглушаются, а верхняя строка прячется.',
        autoOff: 'Новое оформление выключено: Лампа три раза подряд не запустилась с ним. Включить снова можно в настройках Lampa Watch.'
    };

    // Единица времени: 1000 мс. В тестах уменьшается, чтобы не ждать секунды.
    var api = { tick: 1000 };

    var state = { applied: false, bound: false, idleT: null, barT: null, okT: null, last: 0 };

    function store() {
        return window.Lampa && window.Lampa.Storage;
    }

    function read(key, def) {
        try {
            var v = store().get(key, def);

            return v === undefined || v === '' || v === null ? def : v;
        } catch (e) {
            return def;
        }
    }

    function write(key, value) {
        try { store().set(key, value); } catch (e) { /* хранилище недоступно: живём без него */ }
    }

    function isOn() {
        var v = read(K.on, false);

        return v === true || v === 'true';
    }

    // '60s' → 60, '30s' → 30, 'off' и всё непонятное → 0 (защита выключена)
    function idleSeconds(value) {
        var n = parseInt(value, 10);

        return n > 0 ? n : 0;
    }

    function addStyle() {
        if (document.getElementById(STYLE_ID)) return;

        var el = document.createElement('style');

        el.id = STYLE_ID;
        el.textContent = CSS;
        (document.head || document.documentElement).appendChild(el);
    }

    function clearTimers() {
        clearTimeout(state.idleT);
        clearTimeout(state.barT);
        state.idleT = state.barT = null;
    }

    function schedule() {
        clearTimers();

        var sec = idleSeconds(read(K.idle, '60s'));

        if (!sec || !state.applied) return;

        arm('idleT', 'lw-idle', sec);
        arm('barT', 'lw-idle10', Math.min(HIDE_BAR, sec));
    }

    // Во время фильма приглушать нечего: приложение закрыто плеером, а пересчёт стилей сотен карточек под ним мог бы дать пропуск кадра.
    // Пока плеер открыт, таймер просто взводится заново. Признак плеера: его блок .player в документе (класса player--viewing Лампа не ставит).
    function arm(key, cls, sec) {
        state[key] = setTimeout(function () {
            if (document.querySelector('.player')) return arm(key, cls, sec);

            document.body.classList.add(cls);
        }, sec * api.tick);
    }

    function wake() {
        if (!state.applied) return;

        var cl = document.body.classList;
        var dim = cl.contains('lw-idle') || cl.contains('lw-idle10');
        var now = Date.now();

        // мышь шлёт события десятками в секунду: если ничего не приглушено, таймеры пересоздаём не чаще раза в 250 мс
        if (!dim && now - state.last < 250 * (api.tick / 1000)) return;

        state.last = now;

        if (dim) {
            cl.remove('lw-idle');
            cl.remove('lw-idle10');
        }

        schedule();
    }

    function bind() {
        if (state.bound) return;

        state.bound = true;

        ['keydown', 'mousemove', 'click', 'touchstart', 'wheel'].forEach(function (name) {
            document.addEventListener(name, wake, true);
        });
    }

    function apply() {
        addStyle();
        state.applied = true;

        var cl = document.body.classList;

        cl.add('lw-theme');
        cl.toggle('lw-lime', read(K.accent, 'blue') === 'lime');
        bind();
        schedule();
        hero(true);
    }

    function remove() {
        state.applied = false;
        clearTimers();
        document.body.classList.remove('lw-theme', 'lw-lime', 'lw-idle', 'lw-idle10');
        hero(false);
    }

    // Герой главной живёт только вместе с оформлением
    function hero(on) {
        try {
            if (LW.hero) LW.hero[on ? 'on' : 'off']();
        } catch (e) { /* без героя оформление работает */ }
    }

    // Привести вид в соответствие с настройками (после переключателя в Настройках)
    function refresh() {
        if (isOn()) apply();
        else remove();
    }

    function notify(text) {
        try {
            if (window.Lampa && window.Lampa.Noty) window.Lampa.Noty.show(text);
        } catch (e) { /* уведомление не обязательно */ }
    }

    function start() {
        if (!isOn()) return;

        var fails = parseInt(read(K.fails, 0), 10) || 0;

        if (fails >= MAX_FAILS) {
            write(K.on, false);
            write(K.fails, 0);
            notify(TXT.autoOff);

            return;
        }

        write(K.fails, fails + 1);
        apply();

        // дожили до OK_AFTER: запуск удачный, счётчик сбоев обнуляем
        state.okT = setTimeout(function () { write(K.fails, 0); }, OK_AFTER * api.tick);
    }

    function addSettings(settingsApi) {
        var c = 'lampa_watch';

        settingsApi.addParam({ component: c, param: { name: 'lw_theme_title', type: 'title' }, field: { name: TXT.title } });

        settingsApi.addParam({
            component: c,
            param: { name: K.on, type: 'trigger', default: false },
            field: { name: TXT.on, description: TXT.onDescr },
            onChange: function () { setTimeout(refresh, 30); }
        });

        var accent = {};

        accent.blue = TXT.blue;
        accent.lime = TXT.lime;

        settingsApi.addParam({
            component: c,
            param: { name: K.accent, type: 'select', values: accent, default: 'blue' },
            field: { name: TXT.accent },
            onChange: function () { setTimeout(refresh, 30); }
        });

        var idle = {};

        idle['60s'] = TXT.idle60; // ключи не числами, иначе JS переставит их по возрастанию
        idle['30s'] = TXT.idle30;
        idle.off = TXT.idleOff;

        settingsApi.addParam({
            component: c,
            param: { name: K.idle, type: 'select', values: idle, default: '60s' },
            field: { name: TXT.idle, description: TXT.idleDescr },
            onChange: function () { setTimeout(schedule, 30); }
        });
    }

    function boot() {
        try {
            start();
        } catch (e) {
            if (window.console) console.log('[lampa-watch] оформление: ' + e);
        }
    }

    if (window.appready) boot();
    else window.Lampa.Listener.follow('app', function (e) {
        if (e.type === 'ready') boot();
    });

    api.start = start;
    api.apply = apply;
    api.remove = remove;
    api.refresh = refresh;
    api.addSettings = addSettings;
    api.isOn = isOn;
    api.idleSeconds = idleSeconds;
    api.keys = K;
    api.MAX_FAILS = MAX_FAILS;
    api.TXT = TXT;

    return api;
})();
