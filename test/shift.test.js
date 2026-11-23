// Проверка сдвига картинки: круг положений, пропуск шага во время фильма, выключение
// Запуск: NODE_PATH=<папка с node_modules, где есть jsdom> node test/shift.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'src', 'shift.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEnv() {
    const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>');
    const win = dom.window;
    const LW = {};

    new Function('LW', 'window', 'document', CODE)(LW, win, win.document);
    LW.shift.tick = 10; // «секунда» = 10 мс
    LW.shift.every = 2; // шаг раз в 20 мс

    const body = win.document.body;
    const pos = () => [body.style.getPropertyValue('--lw-sx'), body.style.getPropertyValue('--lw-sy')];

    return { S: LW.shift, win, doc: win.document, body, pos };
}

const results = [];

async function test(name, fn) {
    try {
        await fn();
        results.push([true, name]);
    } catch (e) {
        results.push([false, name + '\n      ' + (e && e.stack || e)]);
    }
}

(async function () {
    await test('включение: класс lw-shift и стартовое положение в переменных на body', () => {
        const e = makeEnv();

        e.S.on();
        assert.ok(e.body.classList.contains('lw-shift'));
        assert.deepStrictEqual(e.pos(), ['0px', '0px']);
        e.S.off();
    });

    await test('положения: восемь штук, все в пределах ±5 пикселей, соседние заметно разные, круг замыкается', () => {
        const e = makeEnv();
        const P = e.S.POS;

        assert.strictEqual(P.length, 8);
        P.forEach((p, i) => {
            assert.ok(Math.abs(p[0]) <= 5 && Math.abs(p[1]) <= 5, 'в пределах ±5: ' + p);

            const q = P[(i + 1) % P.length];
            const d = Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]);

            assert.ok(d >= 3, 'сосед отличается минимум на 3 пикселя: ' + p + ' → ' + q);
        });
        assert.strictEqual(new Set(P.map((p) => p.join(','))).size, 8, 'положения не повторяются');
    });

    await test('время: сам сдвигается по кругу с заданным шагом, а не каждый кадр', async () => {
        const e = makeEnv();

        e.S.on();
        assert.strictEqual(e.S.index(), 0);
        await sleep(70);

        const i = e.S.index();

        assert.ok(i >= 1 && i <= 4, 'за 70 мс при шаге 20 мс прошло 1-4 шага, сейчас ' + i);
        assert.deepStrictEqual(e.pos(), [e.S.POS[i][0] + 'px', e.S.POS[i][1] + 'px']);
        e.S.off();
    });

    await test('круг замыкается: после восьмого шага снова нулевое положение', () => {
        const e = makeEnv();

        e.S.on();
        for (let i = 0; i < 8; i++) e.S.step();
        assert.strictEqual(e.S.index(), 0);
        assert.deepStrictEqual(e.pos(), ['0px', '0px']);
        e.S.off();
    });

    await test('идёт фильм (.player в документе): шаг пропускается, после плеера сдвиг продолжается', async () => {
        const e = makeEnv();

        e.S.on();

        const player = e.doc.createElement('div');

        player.className = 'player';
        e.body.appendChild(player);
        await sleep(80);
        assert.strictEqual(e.S.index(), 0, 'пока играет фильм, картинка не прыгает');

        player.remove();
        await sleep(80);
        assert.ok(e.S.index() > 0, 'плеер закрыли, сдвиг пошёл');
        e.S.off();
    });

    await test('повторное включение не заводит второй таймер', async () => {
        const e = makeEnv();

        e.S.on();
        e.S.on();
        await sleep(30);
        assert.ok(e.S.index() <= 2, 'шагов не больше, чем у одного таймера, сейчас ' + e.S.index());
        e.S.off();
    });

    await test('выключение: класс и переменные сняты, таймер остановлен', async () => {
        const e = makeEnv();

        e.S.on();
        await sleep(30);
        e.S.off();
        assert.ok(!e.body.classList.contains('lw-shift'));
        assert.deepStrictEqual(e.pos(), ['', '']);

        const before = e.S.index();

        await sleep(60);
        assert.strictEqual(e.S.index(), before, 'после выключения шагов нет');
        assert.deepStrictEqual(e.pos(), ['', '']);
    });

    await test('сборка: модуль shift вшит в бандл раньше theme', () => {
        const bundle = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'lampa_watch.js'), 'utf8');

        assert.ok(bundle.indexOf('LW.shift = ') >= 0 && bundle.indexOf('LW.shift = ') < bundle.indexOf('LW.theme = '));
    });

    let bad = 0;

    results.forEach(([ok, name]) => { if (!ok) bad++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name); });
    console.log('\n' + (results.length - bad) + '/' + results.length + ' passed');
    process.exit(bad ? 1 : 0);
})();
