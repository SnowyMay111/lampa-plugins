/*
 * Окна и пункты настроек для автоподбора парсера (LW.parser).
 *
 * Настройки → Lampa Watch: кнопка «Подобрать парсер», «Откатить», переключатель автопочинки.
 * Если парсер не ответил при поиске раздачи, watch.js сам зовёт LW.setup.repairParser().
 * Все окна рассчитаны на пульт.
 */
if (!LW.ui || !LW.parser) return;

var U = LW.ui;
var P = LW.parser;
var T = LW.tune;

var AUTO_KEY = 'lw_parser_auto';

var TXT = {
    component: 'Lampa Watch',
    parserTitle: 'Парсер',
    pick: 'Подобрать парсер',
    pickDescr: 'Проверит парсеры и трекеры, выберет самые быстрые и полные и сам впишет их в настройки.',
    now: 'Сейчас',
    rollback: 'Откатить настройки парсера',
    rollbackNone: 'Копии нет: подбор ещё не менял настройки',
    rollbackDone: 'Настройки парсера возвращены',
    rollbackNothing: 'Откатывать нечего',
    copyFrom: 'Копия от',
    auto: 'Чинить парсер автоматически',
    autoDescr: 'Если парсер не отвечает при поиске раздачи, плагин сам подберёт другой и повторит поиск.',
    prefetch: 'Искать раздачи заранее',
    prefetchDescr: 'Когда открыта карточка фильма, плагин заранее спрашивает парсер, и «Лучшая раздача» открывается сразу, без ожидания поиска. Выключите, если парсер платный или медленный.',
    searching: 'Подбираю парсер',
    searchingAuto: 'Парсер не отвечает, подбираю другой',
    searchingSub: 'Проверяю, какие парсеры отвечают на этом устройстве, и сравниваю их по тестовому запросу',
    waiting: 'ждёт',
    checking: 'проверяю…',
    cancel: 'Отмена',
    close: 'Закрыть',
    again: 'Повторить',
    apply: 'Применить',
    found: 'Парсер подобран',
    foundKicker: 'Лучший вариант',
    keep: 'Менять ничего не нужно',
    keepSub: 'Текущий парсер уже работает не хуже остальных.',
    none: 'Рабочий парсер не найден',
    noneSub: 'Ни один из проверенных не ответил. Что можно сделать:',
    tips: [
        'Проверьте, что на устройстве есть интернет.',
        'Если у вас свой Jackett или Prowlarr, проверьте, что он запущен и доступен из этой сети.',
        'Если запущен TorrServer, его встроенный поиск тоже проверяется, но для него нужен адрес TorrServer в настройках.'
    ],
    changes: 'Что изменится',
    checked: 'Проверено',
    mainOne: 'основной',
    mainTwo: 'второй',
    noAnswer: 'нет ответа',
    changed: 'Парсер переключён',
    changedHint: 'Вернуть прежние настройки можно в Настройки → Lampa Watch.',
    applied: 'Парсер настроен',
    seconds: 'с',
    items: 'раздач',
    trackers: 'трекеров',
    score: 'оценка',

    tuneTitle: 'TorrServer',
    tunePick: 'Настроить TorrServer',
    tunePickDescr: 'Прочитает настройки сервера и предложит изменения, которые ускоряют старт и добавляют источников.',
    tuneRollback: 'Откатить настройки TorrServer',
    tuneRollbackNone: 'Копии нет: настройка ещё не меняла сервер',
    tuneRollbackDone: 'Настройки TorrServer возвращены',
    tuneReading: 'Читаю настройки TorrServer',
    tuneReadingSub: 'Смотрю, что стоит на сервере',
    tuneWriting: 'Применяю настройки',
    tuneWritingSub: 'Сервер перезапускает торрент-клиент, это займёт пару секунд',
    tuneErrTitle: 'Не удалось настроить TorrServer',
    tuneKicker: 'Настройка TorrServer',
    tuneNoChanges: 'Сервер уже настроен хорошо',
    tuneNoChangesSub: 'Менять нечего: то, что ускоряет старт и добавляет источников, у вас уже включено.',
    tuneKeptCopy: 'Копия прежних настроек сохранена: вернуть их можно в Настройки → Lampa Watch → «Откатить настройки TorrServer».',
    tuneWarn: 'Применение перезапускает торрент-клиент TorrServer: идущая раздача прервётся. Прежние настройки сохранятся, вернуть их можно в Настройки → Lampa Watch → «Откатить настройки TorrServer».',
    tuneDone: 'TorrServer настроен',
    tuneNotes: 'К сведению',
    server: 'Сервер'
};

var KEY_NAME = {
    parser_torrent_type: 'Тип парсера',
    parser_use: 'Использовать парсер',
    parser_use_link: 'Какие ссылки',
    jackett_url: 'Jackett: ссылка', jackett_key: 'Jackett: ключ',
    jackett_url_two: 'Jackett: вторая ссылка', jackett_key_two: 'Jackett: ключ второй',
    prowlarr_url: 'Prowlarr: ссылка', prowlarr_key: 'Prowlarr: ключ',
    prowlarr_url_two: 'Prowlarr: вторая ссылка', prowlarr_key_two: 'Prowlarr: ключ второй',
    torrserver_search_type: 'Поиск TorrServer'
};

var VALUE_NAME = {
    parser_torrent_type: { jackett: 'Jackett', prowlarr: 'Prowlarr', torrserver: 'TorrServer' },
    parser_use_link: { one: 'только основная', two: 'только вторая', both: 'обе сразу' },
    parser_use: { 'true': 'да', 'false': 'нет' },
    torrserver_search_type: { rutor: 'Rutor', torznab: 'Torznab', both: 'оба' }
};

var runToken = 0;

// ---------------------------------------------------------------- оформление

function addStyle() {
    if (document.getElementById('lw-setup-style')) return;

    var css = [
        '.lw-prow{display:flex;align-items:center;padding:.55em .9em;margin-bottom:.3em;border-radius:.55em;background:rgba(255,255,255,.07)}',
        '.lw-prow__dot{flex:none;width:.75em;height:.75em;margin-right:.85em;border-radius:50%;background:rgba(255,255,255,.3)}',
        '.lw-prow--run .lw-prow__dot{background:#f2c94c}',
        '.lw-prow--ok .lw-prow__dot{background:#6fcf97}',
        '.lw-prow--bad .lw-prow__dot{background:#eb5757}',
        '.lw-prow--best{box-shadow:inset 0 0 0 .14em #2f6fe4}',
        '.lw-prow__name{flex:1;min-width:0;word-break:break-all}',
        '.lw-prow__tag{display:inline-block;margin-left:.6em;padding:.05em .5em;border-radius:.35em;background:#2f6fe4;font-size:.75em}',
        '.lw-prow__info{margin-left:1em;opacity:.7;font-size:.9em;text-align:right}',
        '.lw-chg{display:flex;justify-content:space-between;padding:.35em 0;border-bottom:1px solid rgba(255,255,255,.08)}',
        '.lw-chg__k{opacity:.7}',
        '.lw-chg__v{text-align:right;word-break:break-all;margin-left:1em}',
        '.lw-chg__v s{opacity:.5;margin-right:.5em}',
        '.lw-h{margin:1em 0 .4em;opacity:.55;font-size:.85em;letter-spacing:.06em;text-transform:uppercase}',
        '.lw-tc{padding:.6em .9em;margin-bottom:.35em;border-radius:.55em;background:rgba(255,255,255,.07)}',
        '.lw-tc__top{display:flex;justify-content:space-between;align-items:baseline}',
        '.lw-tc__name{font-weight:600}',
        '.lw-tc__val{text-align:right;margin-left:1em}',
        '.lw-tc__val s{opacity:.5;margin-right:.5em}',
        '.lw-tc__why{opacity:.65;font-size:.9em;margin-top:.25em;line-height:1.35}'
    ].join('\n');

    var el = document.createElement('style');

    el.id = 'lw-setup-style';
    el.appendChild(document.createTextNode(css));
    document.head.appendChild(el);
}

// ---------------------------------------------------------------- вспомогательное

function autoOn() {
    try {
        var v = window.Lampa.Storage.get(AUTO_KEY, true);

        return !(v === false || v === 'false');
    } catch (e) {
        return true;
    }
}

function secs(ms) {
    return (Math.round(ms / 100) / 10).toFixed(1);
}

// 1 раздача, 2 раздачи, 5 раздач
function plural(n, one, few, many) {
    var a = Math.abs(n) % 100;
    var b = a % 10;

    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;

    return b === 1 ? one : many;
}

function shown(key, v) {
    var map = VALUE_NAME[key];
    var s = v === undefined || v === null ? '' : String(v);

    if (/_key/.test(key)) return s ? '••••' : 'пусто';
    if (map && map[s]) return map[s];

    return s || 'пусто';
}

function when(ts) {
    var d = new Date(ts);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };

    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function infoOf(res) {
    if (!res.ok) return res.error || TXT.noAnswer;
    if (res.rating < 15) return secs(res.ms) + ' ' + TXT.seconds + ' · пусто по тестовому запросу';

    return secs(res.ms) + ' ' + TXT.seconds + ' · ' + res.ev.relevant + ' ' + plural(res.ev.relevant, 'раздача', 'раздачи', 'раздач') + ' · ' + res.ev.trackers.length + ' ' + plural(res.ev.trackers.length, 'трекер', 'трекера', 'трекеров') + ' · ' + TXT.score + ' ' + res.rating;
}

function nameOf(c) {
    return (P.TYPE_NAME[c.type] && c.type !== 'torrserver' ? P.TYPE_NAME[c.type] + ' · ' : '') + P.labelOf(c);
}

function resultRows(out, plan) {
    var box = $('<div></div>');

    out.results.forEach(function (r) {
        var tag = '';
        var row = U.h('div', 'lw-prow lw-prow--' + (r.ok && r.rating >= 15 ? 'ok' : 'bad'));
        var name = U.h('div', 'lw-prow__name', nameOf(r.cand));

        if (plan && plan.primary === r) tag = TXT.mainOne;
        else if (plan && plan.secondary === r) tag = TXT.mainTwo;

        if (tag) {
            row.addClass('lw-prow--best');
            name.append(U.h('span', 'lw-prow__tag', tag));
        }

        row.append(U.h('div', 'lw-prow__dot'));
        row.append(name);
        row.append(U.h('div', 'lw-prow__info', infoOf(r)));
        box.append(row);
    });

    return box;
}

// ---------------------------------------------------------------- окно проверки

// opts: { auto: true — сразу применить найденное, back: имя контроллера, куда вернуть фокус по окончании
// (Лампа сама его не возвращает, если окно открыто не поверх другого окна), onDone(status) — 'applied' | 'kept' | 'none' | 'cancel' }
function openParserSetup(opts) {
    opts = opts || {};

    var mine = ++runToken;
    var box = U.h('div', 'lw-box');
    var bar = $('<div class="lw-bar"><i style="width:3%"></i></div>');
    var list = U.h('div', 'lw-list');
    var rows = {};
    var doneCalled = false;

    function finish(status) {
        if (doneCalled) return;

        doneCalled = true;

        if (opts.back) {
            try { window.Lampa.Controller.toggle(opts.back); } catch (e) {}
        }

        if (opts.onDone) opts.onDone(status);
    }

    function cancelIt() {
        runToken++;

        try { P.cancel(); } catch (e) {}

        U.closeModal();
        finish('cancel');
    }

    box.append(U.h('div', 'lw-title', opts.auto ? TXT.searchingAuto : TXT.searching));
    box.append(U.h('div', 'lw-line', TXT.searchingSub));
    box.append(bar);
    box.append(list);

    U.openModal({ title: '', html: box, size: 'large', buttons: [{ name: TXT.cancel, onSelect: cancelIt }], onBack: cancelIt });

    function setRow(c, cls, info) {
        var r = rows[c.id];

        if (!r) return;

        r.row.removeClass('lw-prow--run lw-prow--ok lw-prow--bad').addClass(cls);
        r.info.text(info);
    }

    P.run({
        onList: function (cands) {
            cands.forEach(function (c) {
                var row = U.h('div', 'lw-prow');
                var info = U.h('div', 'lw-prow__info', TXT.waiting);

                row.append(U.h('div', 'lw-prow__dot'));
                row.append(U.h('div', 'lw-prow__name', nameOf(c)));
                row.append(info);
                list.append(row);

                rows[c.id] = { row: row, info: info };
            });
        },
        onStart: function (c) { setRow(c, 'lw-prow--run', TXT.checking); },
        onResult: function (res, n, total) {
            setRow(res.cand, res.ok && res.rating >= 15 ? 'lw-prow--ok' : 'lw-prow--bad', infoOf(res));
            bar.find('i').css('width', Math.max(3, Math.round(100 * n / total)) + '%');
        }
    }, function (out) {
        if (mine !== runToken) return;

        U.closeModal();

        if (!out.plan) return showNone(out, opts, finish);
        if (opts.auto) return autoApply(out, finish);

        showFound(out, opts, finish);
    });
}

function autoApply(out, finish) {
    var changes = P.apply(out.plan);

    if (!changes.length) return finish('kept');

    U.noty(TXT.changed + ': ' + P.describe(out.plan));
    U.noty(TXT.changedHint);
    refreshSettings();
    finish('applied');
}

function showNone(out, opts, finish) {
    var box = U.h('div', 'lw-box');
    var tips = $('<ul class="lw-tips"></ul>');

    box.append(U.h('div', 'lw-title', TXT.none));
    box.append(U.h('div', 'lw-line', TXT.noneSub));

    TXT.tips.forEach(function (t) { tips.append(U.h('li', '', t)); });
    box.append(tips);

    box.append(U.h('div', 'lw-h', TXT.checked + ': ' + out.results.length));
    box.append(resultRows(out, null));

    function again() {
        U.closeModal();
        openParserSetup(opts);
    }

    function close() {
        U.closeModal();
        finish('none');
    }

    U.openModal({ title: '', html: box, size: 'large', buttons: [{ name: TXT.again, onSelect: again }, { name: TXT.close, onSelect: close }], onBack: close });
}

function changesBlock(plan) {
    var box = $('<div></div>');

    box.append(U.h('div', 'lw-h', TXT.changes));

    plan.changes.forEach(function (c) {
        var v = U.h('div', 'lw-chg__v');

        if (String(c.from) !== '' ) v.append($('<s></s>').text(shown(c.key, c.from)));

        v.append(document.createTextNode(shown(c.key, c.to)));

        box.append($('<div class="lw-chg"></div>').append(U.h('div', 'lw-chg__k', KEY_NAME[c.key] || c.key)).append(v));
    });

    return box;
}

function showFound(out, opts, finish) {
    var plan = out.plan;
    var box = U.h('div', 'lw-box');
    var badges = U.h('div', 'lw-badges');
    var p = plan.primary;
    var buttons = [];

    box.append(U.h('div', 'lw-kicker', plan.changed ? TXT.foundKicker : TXT.keep));
    box.append(U.h('div', 'lw-title', P.describe(plan)));

    if (plan.type !== 'torrserver') {
        badges.append(U.h('span', 'lw-badge lw-badge--hot', secs(p.ms) + ' ' + TXT.seconds));
        badges.append(U.h('span', 'lw-badge', p.ev.relevant + ' ' + plural(p.ev.relevant, 'раздача', 'раздачи', 'раздач')));
        badges.append(U.h('span', 'lw-badge', p.ev.trackers.length + ' ' + plural(p.ev.trackers.length, 'трекер', 'трекера', 'трекеров')));
        box.append(badges);
        box.append(U.h('div', 'lw-line', p.ev.trackers.join(', ')));
    }

    if (!plan.changed) box.append(U.h('div', 'lw-note', TXT.keepSub));
    else box.append(changesBlock(plan));

    box.append(U.h('div', 'lw-h', TXT.checked + ': ' + out.results.length));
    box.append(resultRows(out, plan));

    function close() {
        U.closeModal();
        finish(plan.changed ? 'cancel' : 'kept');
    }

    if (plan.changed) {
        buttons.push({ name: TXT.apply, onSelect: function () {
            P.apply(plan);
            U.closeModal();
            U.noty(TXT.applied + ': ' + P.describe(plan));
            refreshSettings();
            finish('applied');
        } });
    }

    buttons.push({ name: TXT.close, onSelect: close });

    U.openModal({ title: '', html: box, size: 'large', buttons: buttons, onBack: close });
}

// Для watch.js: парсер не ответил при поиске. Подбираем другой молча (кроме окна хода проверки).
function repairParser(done) {
    openParserSetup({ auto: true, onDone: done });
}

// ---------------------------------------------------------------- окна настройки TorrServer

var tuneToken = 0;

function busyModal(title, sub, onCancel) {
    var box = U.h('div', 'lw-box');

    box.append(U.h('div', 'lw-title', title));
    box.append(U.h('div', 'lw-line', sub));
    box.append($('<div class="lw-bar"><i style="width:60%"></i></div>'));

    // пока идёт запись на сервер, закрывать окно нельзя: оборвём на середине
    U.openModal({ title: '', html: box, size: 'small', buttons: onCancel ? [{ name: TXT.cancel, onSelect: onCancel }] : [], onBack: onCancel || function () {} });
}

function tuneChangesBlock(plan) {
    var box = $('<div></div>');

    plan.changes.forEach(function (c) {
        var val = U.h('div', 'lw-tc__val');

        val.append($('<s></s>').text(c.fromText));
        val.append(document.createTextNode(c.toText));

        box.append($('<div class="lw-tc"></div>')
            .append($('<div class="lw-tc__top"></div>').append(U.h('div', 'lw-tc__name', c.label)).append(val))
            .append(U.h('div', 'lw-tc__why', c.why)));
    });

    return box;
}

// opts: { back: контроллер для возврата фокуса, onDone(status) — 'applied' | 'kept' | 'error' | 'cancel' }
function openTune(opts) {
    opts = opts || {};

    var mine = ++tuneToken;
    var doneCalled = false;

    function finish(status) {
        if (doneCalled) return;

        doneCalled = true;

        if (opts.back) {
            try { window.Lampa.Controller.toggle(opts.back); } catch (e) {}
        }

        if (opts.onDone) opts.onDone(status);
    }

    function cancelIt() {
        tuneToken++;
        U.closeModal();
        finish('cancel');
    }

    function showError(err, written) {
        var box = U.h('div', 'lw-box');

        if (LW.health) LW.health.note('tune', TXT.tuneErrTitle + ': ' + err);

        box.append(U.h('div', 'lw-title', TXT.tuneErrTitle));
        box.append(U.h('div', 'lw-line', err));

        if (written && T.hasBackup()) box.append(U.h('div', 'lw-note', TXT.tuneKeptCopy));

        function close() {
            U.closeModal();
            finish('error');
        }

        U.openModal({ title: '', html: box, buttons: [{ name: TXT.again, onSelect: function () { U.closeModal(); openTune(opts); } }, { name: TXT.close, onSelect: close }], onBack: close });
    }

    function showPlan(cur, plan) {
        var box = U.h('div', 'lw-box');
        var n = plan.changes.length;
        var buttons = [];

        function close() {
            U.closeModal();
            finish(n ? 'cancel' : 'kept');
        }

        box.append(U.h('div', 'lw-kicker', TXT.tuneKicker));
        box.append(U.h('div', 'lw-title', n ? 'Предлагаю ' + n + ' ' + plural(n, 'изменение', 'изменения', 'изменений') : TXT.tuneNoChanges));
        box.append(U.h('div', 'lw-line', TXT.server + ': ' + P.hostOf(T.baseUrl())));

        if (n) box.append(tuneChangesBlock(plan));
        else box.append(U.h('div', 'lw-note', TXT.tuneNoChangesSub));

        if (plan.notes.length) {
            box.append(U.h('div', 'lw-h', TXT.tuneNotes));
            plan.notes.forEach(function (t) { box.append(U.h('div', 'lw-note', t)); });
        }

        if (n) {
            box.append(U.h('div', 'lw-stats', TXT.tuneWarn));

            buttons.push({ name: TXT.apply, onSelect: function () {
                U.closeModal();
                busyModal(TXT.tuneWriting, TXT.tuneWritingSub);

                T.apply(plan, cur, function (err) {
                    if (mine !== tuneToken) return;

                    U.closeModal();

                    if (err) return showError(err, true);

                    U.noty(TXT.tuneDone + ': ' + n + ' ' + plural(n, 'изменение', 'изменения', 'изменений'));
                    refreshSettings();
                    finish('applied');
                });
            } });
        }

        buttons.push({ name: TXT.close, onSelect: close });

        U.openModal({ title: '', html: box, size: 'large', buttons: buttons, onBack: close });
    }

    busyModal(TXT.tuneReading, TXT.tuneReadingSub, cancelIt);

    T.load(function (err, cur) {
        if (mine !== tuneToken) return;

        U.closeModal();

        if (err) return showError(err);

        showPlan(cur, T.plan(cur, { line: T.lineMbps() }));
    });
}

function doTuneRollback() {
    if (!T.hasBackup()) return U.noty(TXT.rollbackNothing);

    U.noty(TXT.tuneWriting + '…');

    T.rollback(function (err) {
        U.noty(err ? TXT.tuneErrTitle + ': ' + err : TXT.tuneRollbackDone);
        refreshSettings();
    });
}

// ---------------------------------------------------------------- настройки Лампы

var settingItems = {};

function refreshSettings() {
    var b = P.loadBackup();

    if (settingItems.pick) settingItems.pick.find('.settings-param__descr').text(TXT.now + ': ' + P.currentLabel());
    if (settingItems.rollback) settingItems.rollback.find('.settings-param__descr').text(b ? TXT.copyFrom + ' ' + when(b.at) + ' (' + (b.summary || '') + ')' : TXT.rollbackNone);

    if (T) {
        var tb = T.loadBackup();
        var addr = T.baseUrl();

        if (settingItems.tune) settingItems.tune.find('.settings-param__descr').text(TXT.tunePickDescr + (addr ? ' ' + TXT.server + ': ' + P.hostOf(addr) + '.' : ''));
        if (settingItems.tuneRollback) settingItems.tuneRollback.find('.settings-param__descr').text(tb ? TXT.copyFrom + ' ' + when(tb.at) : TXT.tuneRollbackNone);
    }
}

function doRollback() {
    if (!P.hasBackup()) return U.noty(TXT.rollbackNothing);

    P.rollback();
    U.noty(TXT.rollbackDone);
    refreshSettings();
}

function addSettings() {
    var api = window.Lampa.SettingsApi;

    if (!api) return;

    api.addComponent({
        component: 'lampa_watch',
        name: TXT.component,
        icon: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="2"/><path d="M16 16l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8.5 11.2l1.8 1.8 3.4-3.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    });

    // «Диагностика и обновление» первой строкой: с неё начинают, когда что-то не работает
    if (LW.health) LW.health.addSettings(api);

    api.addParam({ component: 'lampa_watch', param: { name: 'lw_parser_title', type: 'title' }, field: { name: TXT.parserTitle } });

    api.addParam({
        component: 'lampa_watch',
        param: { name: 'lw_parser_pick', type: 'button' },
        field: { name: TXT.pick, description: TXT.pickDescr },
        onRender: function (item) { settingItems.pick = item; refreshSettings(); },
        onChange: function () { openParserSetup({ back: 'settings_component', onDone: function () { refreshSettings(); } }); }
    });

    api.addParam({
        component: 'lampa_watch',
        param: { name: 'lw_parser_rollback', type: 'button' },
        field: { name: TXT.rollback, description: TXT.rollbackNone },
        onRender: function (item) { settingItems.rollback = item; refreshSettings(); },
        onChange: doRollback
    });

    api.addParam({
        component: 'lampa_watch',
        param: { name: AUTO_KEY, type: 'trigger', default: true },
        field: { name: TXT.auto, description: TXT.autoDescr }
    });

    api.addParam({
        component: 'lampa_watch',
        param: { name: 'lw_prefetch', type: 'trigger', default: true },
        field: { name: TXT.prefetch, description: TXT.prefetchDescr }
    });

    if (!T) return;

    api.addParam({ component: 'lampa_watch', param: { name: 'lw_tune_title', type: 'title' }, field: { name: TXT.tuneTitle } });

    api.addParam({
        component: 'lampa_watch',
        param: { name: 'lw_tune_pick', type: 'button' },
        field: { name: TXT.tunePick, description: TXT.tunePickDescr },
        onRender: function (item) { settingItems.tune = item; refreshSettings(); },
        onChange: function () { openTune({ back: 'settings_component', onDone: function () { refreshSettings(); } }); }
    });

    api.addParam({
        component: 'lampa_watch',
        param: { name: 'lw_tune_rollback', type: 'button' },
        field: { name: TXT.tuneRollback, description: TXT.tuneRollbackNone },
        onRender: function (item) { settingItems.tuneRollback = item; refreshSettings(); },
        onChange: doTuneRollback
    });
}

// Раздел «Оформление» (бета). Он нужен и тогда, когда TorrServer-настройка недоступна, поэтому вызывается отдельно
function addThemeSettings() {
    var api = window.Lampa.SettingsApi;

    if (api && LW.theme) LW.theme.addSettings(api);
}

function start() {
    try {
        addStyle();
        addSettings();
        addThemeSettings();
    } catch (e) {
        if (window.console) console.log('[lampa-watch] настройки: ' + e);
    }
}

if (window.appready) start();
else window.Lampa.Listener.follow('app', function (e) {
    if (e.type === 'ready') start();
});

LW.setup = { openParserSetup: openParserSetup, repairParser: repairParser, openTune: openTune, autoOn: autoOn, start: start };
