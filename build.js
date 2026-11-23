// Собирает все модули из src/ в один файл plugins/lampa_watch.js.
// Запуск: node build.js. Версия берётся из manifest.json (запись lampa_watch).
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = __dirname;
var MODULES = ['health', 'speed', 'score', 'series', 'list', 'parser', 'tune', 'failover', 'theme', 'watch', 'setup']; // порядок важен: журнал ошибок (health) нужен всем, оценка использует прогноз скорости, окна подбора парсера используют LW.ui из watch, настройки темы добавляет setup

// CSS темы живёт в src/theme.css: убираем комментарии и лишние пробелы и вшиваем в theme.js строкой
function themeCss() {
    return fs.readFileSync(path.join(ROOT, 'src', 'theme.css'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\s+/g, ' ')
        .replace(/\s*([{};])\s*/g, '$1')
        .trim();
}

var manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
var entry = manifest.plugins.filter(function (p) { return p.id === 'lampa_watch'; })[0];

if (!entry) throw new Error('В manifest.json нет записи lampa_watch');

var out = [];

out.push('/*');
out.push(' * Lampa Watch ' + entry.version);
out.push(' * Подбор лучшей раздачи, прогноз «будет ли лагать», автопереключение TorrServer.');
out.push(' * Файл собран из src/ командой node build.js. Править нужно исходники, а не этот файл.');
out.push(' */');
out.push('(function () {');
out.push("    'use strict';");
out.push('');
out.push('    if (window.lampa_watch_bundle) return;');
out.push('    window.lampa_watch_bundle = true;');
out.push('');
out.push("    var LW = { version: '" + entry.version + "' };");
out.push('    // адрес, с которого загружен файл: диагностика показывает его человеку (currentScript есть только пока файл выполняется)');
out.push("    try { LW.src = (document.currentScript && document.currentScript.src) || ''; } catch (e) { LW.src = ''; }");
out.push('');
out.push('    // Каждый модуль в своей оболочке: сбой одного не мешает остальным');
out.push('    function run(name, fn) {');
out.push('        try { fn(LW); } catch (e) {');
out.push('            if (window.console) console.log("[lampa-watch] модуль " + name + ": " + e);');
out.push('            if (LW.health) LW.health.note("module", "Модуль " + name + " не запустился: " + e);');
out.push('        }');
out.push('    }');
out.push('');

MODULES.forEach(function (name) {
    var code = fs.readFileSync(path.join(ROOT, 'src', name + '.js'), 'utf8').replace(/\s+$/, '');

    if (name === 'theme') {
        if (code.indexOf("'__THEME_CSS__'") < 0) throw new Error('в theme.js нет метки __THEME_CSS__');
        code = code.replace("'__THEME_CSS__'", function () { return JSON.stringify(themeCss()); });
    }

    out.push("    run('" + name + "', function (LW) {");
    out.push("        'use strict';");
    out.push('');
    out.push(code.split('\n').map(function (line) { return line ? '        ' + line : line; }).join('\n'));
    out.push('    });');
    out.push('');
});

out.push('})();');
out.push('');

fs.mkdirSync(path.join(ROOT, 'plugins'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'plugins', 'lampa_watch.js'), out.join('\n'));

console.log('plugins/lampa_watch.js собран, версия ' + entry.version);
