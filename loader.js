/*
 * Lampa Plugins: загрузчик
 *
 * Эту ссылку добавляют в Лампу один раз (Настройки -> Расширения -> Добавить плагин).
 * Дальше загрузчик сам при каждом запуске Лампы читает manifest.json и подключает
 * свежие версии всех включённых плагинов. Новые плагины и обновления появляются
 * без смены ссылки, нужно только перезапустить Лампу.
 */
(function () {
    'use strict';

    if (window.lampa_plugins_loader) return;
    window.lampa_plugins_loader = true;

    var FALLBACK_BASE = 'https://snowymay111.github.io/lampa-plugins/';
    var KEY_MANIFEST  = 'lampa_plugins_manifest'; // последний удачно загруженный список
    var KEY_VERSIONS  = 'lampa_plugins_versions'; // какие версии были при прошлом запуске
    var TIMEOUT       = 8000;

    // Папка, откуда загружен сам загрузчик. Если браузер её не сообщает, берём адрес по умолчанию.
    var BASE = (function () {
        try {
            var src = document.currentScript && document.currentScript.src;

            if (src) return src.split('?')[0].replace(/[^\/]*$/, '');
        } catch (e) {}

        return FALLBACK_BASE;
    })();

    function readJSON(key) {
        try { return JSON.parse(window.localStorage.getItem(key)); } catch (e) { return null; }
    }

    function writeJSON(key, value) {
        try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
    }

    function getJSON(url, done) {
        var finished = false;
        var xhr      = new XMLHttpRequest();

        function end(error, data) {
            if (finished) return;

            finished = true;
            done(error, data);
        }

        try {
            xhr.open('GET', url, true);
            xhr.timeout = TIMEOUT;

            xhr.onload = function () {
                if (xhr.status !== 200) return end(new Error('HTTP ' + xhr.status));

                try { end(null, JSON.parse(xhr.responseText)); } catch (e) { end(e); }
            };
            xhr.onerror = xhr.ontimeout = function () { end(new Error('network')); };

            xhr.send();
        } catch (e) {
            end(e);
        }
    }

    function loadScript(url) {
        var script = document.createElement('script');

        script.src   = url;
        script.async = false; // сохраняем порядок плагинов из manifest.json
        script.onerror = function () {
            if (window.console) console.log('[lampa-plugins] не удалось загрузить ' + url);
        };

        (document.head || document.documentElement).appendChild(script);
    }

    function notify(list) {
        var tries = 0;

        (function wait() {
            if (window.Lampa && window.Lampa.Noty && window.Lampa.Noty.show) {
                return window.Lampa.Noty.show('Плагины обновлены: ' + list.join(', '));
            }

            if (++tries < 20) setTimeout(wait, 500);
        })();
    }

    // fresh = список только что получен из сети (а не взят из запасной копии)
    function run(manifest, fresh) {
        var plugins = (manifest && manifest.plugins) || [];
        var known   = readJSON(KEY_VERSIONS) || {};
        var first   = Object.keys(known).length === 0;
        var next    = {};
        var changes = [];

        plugins.forEach(function (plugin) {
            if (!plugin || !plugin.file || plugin.enabled === false) return;

            var id      = plugin.id || plugin.file;
            var version = plugin.version || '0';
            var name    = plugin.name || id;

            next[id] = version;

            if (!first) {
                if (!known.hasOwnProperty(id)) changes.push(name + ' (новый)');
                else if (known[id] !== version) changes.push(name + ' ' + version);
            }

            // версия в адресе: новая версия всегда скачивается заново, старая берётся из кэша
            loadScript(BASE + plugin.file + '?v=' + encodeURIComponent(version));
        });

        if (fresh) {
            writeJSON(KEY_VERSIONS, next);

            if (changes.length) notify(changes);
        }
    }

    // t= чтобы список всегда был свежим, а не из кэша браузера
    getJSON(BASE + 'manifest.json?t=' + new Date().getTime(), function (error, manifest) {
        if (!error && manifest && manifest.plugins) {
            writeJSON(KEY_MANIFEST, manifest);
            run(manifest, true);
        } else {
            run(readJSON(KEY_MANIFEST), false);
        }
    });
})();
