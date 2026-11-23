/*
 * Герой главной: большой кадр сверху, под ним название, оценка и описание той карточки, на которой стоит фокус.
 * Ряды при этом уходят в нижнюю часть экрана и показываются «окном» (это делает theme.css по классу body.lw-home).
 *
 * Данные берём не из разметки, а из самой Лампы: когда фокус встаёт на карточку, Лампа вызывает
 * Utils.cardImgBackground(данные карточки), чтобы сменить фон. Мы оборачиваем эту функцию: она работает как раньше,
 * а мы заодно получаем название, описание, оценку и кадр. Ничего своего в данные не пишем.
 *
 * Тяжёлого тут нет: один кадр за раз, смена с задержкой (пока фокус бежит по ряду, ничего не грузится),
 * плавность только через opacity. Работает только когда включено новое оформление и открыта главная.
 */
LW.hero = (function () {
    var api = { delay: 140 };
    var state = { on: false, bound: false, el: null, parts: null, key: '', url: '', layer: 0, t: null, syncT: null };

    function L() {
        return window.Lampa;
    }

    function make(tag, cls) {
        var e = document.createElement(tag);

        if (cls) e.className = cls;

        return e;
    }

    // Открыта ли сейчас главная (а не карточка, поиск, каталог)
    function isHome() {
        try {
            var a = L().Activity.active();

            return !!(a && a.component === 'main');
        } catch (e) {
            return false;
        }
    }

    function build() {
        if (state.el && state.el.parentNode) return state.el;

        var slides = document.querySelector('.wrap__content .activitys');

        if (!slides) return null;

        var el = make('div', 'lw-hero');
        var a = make('div', 'lw-hero__img');
        var b = make('div', 'lw-hero__img');
        var text = make('div', 'lw-hero__text');
        var p = { kicker: make('div', 'lw-hero__kicker'), title: make('div', 'lw-hero__title'), meta: make('div', 'lw-hero__meta'), desc: make('div', 'lw-hero__desc'), imgs: [a, b] };

        text.appendChild(p.kicker);
        text.appendChild(p.title);
        text.appendChild(p.meta);
        text.appendChild(p.desc);
        el.appendChild(a);
        el.appendChild(b);
        el.appendChild(make('div', 'lw-hero__shade'));
        el.appendChild(text);
        slides.parentNode.insertBefore(el, slides);

        state.el = el;
        state.parts = p;
        state.key = '';

        return el;
    }

    // body.lw-home: главная открыта и герой включён. По нему тема сдвигает ряды вниз.
    function sync() {
        var home = state.on && isHome();

        document.body.classList.toggle('lw-home', home);

        if (home) build();
    }

    function later() {
        clearTimeout(state.syncT);
        state.syncT = setTimeout(sync, 60); // Лампа переключает активность чуть позже самого события
    }

    function kicker(d) {
        var tv = !!(d.first_air_date || d.name || d.media_type === 'tv');
        var year = String(d.release_date || d.first_air_date || '').slice(0, 4);

        return (tv ? 'Сериал' : 'Фильм') + (year ? ' · ' + year : '');
    }

    function imageUrl(path) {
        try {
            if (L().TMDB && L().TMDB.image) return L().TMDB.image('t/p/w1280' + path);
        } catch (e) { /* возьмём прямой адрес */ }

        return 'https://image.tmdb.org/t/p/w1280' + path;
    }

    // Кадр меняем через два слоя и opacity: новый догружается, потом плавно проявляется поверх старого
    function image(path) {
        if (!path) return;

        var url = imageUrl(path);

        if (url === state.url) return;

        state.url = url;

        var im = new Image();

        im.onload = function () {
            if (state.url !== url || !state.parts) return;

            var imgs = state.parts.imgs;
            var next = imgs[state.layer ? 0 : 1];

            next.style.backgroundImage = 'url("' + url + '")';
            next.classList.add('is-on');
            imgs[state.layer].classList.remove('is-on');
            state.layer = state.layer ? 0 : 1;
        };
        im.src = url;
    }

    function paint(d) {
        if (!state.on || !isHome() || !build()) return;

        var p = state.parts;

        p.kicker.textContent = kicker(d);
        p.title.textContent = d.title || d.name || '';
        p.desc.textContent = d.overview || '';
        p.meta.textContent = '';

        if (d.vote_average > 0) {
            var chip = make('span', 'lw-hero__chip');

            chip.textContent = '★ ' + Number(d.vote_average).toFixed(1);
            p.meta.appendChild(chip);
        }

        image(d.backdrop_path);
    }

    function show(d) {
        if (!state.on || !d || typeof d !== 'object' || !(d.title || d.name)) return;
        if (!isHome()) {
            if (document.body.classList.contains('lw-home')) sync();

            return;
        }

        if (!document.body.classList.contains('lw-home')) sync();

        var key = String(d.id) + '|' + (d.backdrop_path || '');

        if (key === state.key) return;

        state.key = key;
        clearTimeout(state.t);
        state.t = setTimeout(function () { paint(d); }, api.delay);
    }

    // Оборачиваем функции Лампы, которыми она берёт кадр карточки для фона. Возвращают они то же самое.
    function wrap() {
        var U = L() && L().Utils;

        ['cardImgBackground', 'cardImgBackgroundBlur'].forEach(function (name) {
            var orig = U && U[name];

            if (typeof orig !== 'function' || orig.lwHero) return;

            var fn = function (d) {
                var r = orig.apply(this, arguments);

                try { show(d); } catch (e) { /* герой не должен ломать фон Лампы */ }

                return r;
            };

            fn.lwHero = true;
            U[name] = fn;
        });
    }

    function bind() {
        if (state.bound) return;

        state.bound = true;

        try { L().Listener.follow('activity', later); } catch (e) { /* без событий синхронизируем при фокусе */ }
    }

    function on() {
        state.on = true;
        wrap();
        bind();
        sync();
    }

    function off() {
        state.on = false;
        clearTimeout(state.t);
        document.body.classList.remove('lw-home');

        if (state.el && state.el.parentNode) state.el.parentNode.removeChild(state.el);

        state.el = null;
        state.parts = null;
        state.key = '';
        state.url = '';
    }

    api.on = on;
    api.off = off;
    api.sync = sync;
    api.show = show;
    api.isHome = isHome;
    api.kicker = kicker;

    return api;
})();
