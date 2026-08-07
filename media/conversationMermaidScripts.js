(function () {
    'use strict';

    function create(options) {
        var objectUrls = [];
        var sources = new WeakMap();
        var initialized = false;
        var loadPromise = null;

        function release(root) {
            var urls = root
                ? Array.prototype.map.call(
                    root.querySelectorAll(
                        '.conversation-mermaid-image[src^="blob:"]'
                    ),
                    function (image) {
                        return image.src;
                    }
                )
                : objectUrls.slice();
            var released = new Set(urls);
            urls.forEach(function (url) {
                try {
                    URL.revokeObjectURL(url);
                } catch (_error) {
                    // Revocation is best-effort during document teardown.
                }
            });
            objectUrls = objectUrls.filter(function (url) {
                return !released.has(url);
            });
        }

        function themeValue(name, fallback) {
            var value = window.getComputedStyle(document.body)
                .getPropertyValue(name)
                .trim();
            return value || fallback;
        }

        function initialize() {
            if (initialized) return true;
            if (!window.mermaid
                || typeof window.mermaid.initialize !== 'function') {
                return false;
            }
            try {
                window.mermaid.initialize({
                    startOnLoad: false,
                    securityLevel: 'strict',
                    suppressErrorRendering: true,
                    maxTextSize: 50000,
                    htmlLabels: false,
                    theme: 'base',
                    fontFamily: themeValue(
                        '--vscode-font-family',
                        'system-ui, sans-serif'
                    ),
                    flowchart: {
                        htmlLabels: false,
                    },
                    themeVariables: {
                        darkMode: document.body.classList.contains(
                            'vscode-dark'
                        ) || document.body.classList.contains(
                            'vscode-high-contrast'
                        ),
                        background: themeValue(
                            '--vscode-editor-background',
                            '#1e1e1e'
                        ),
                        primaryColor: themeValue(
                            '--vscode-textCodeBlock-background',
                            '#252526'
                        ),
                        primaryTextColor: themeValue(
                            '--vscode-editor-foreground',
                            '#d4d4d4'
                        ),
                        primaryBorderColor: themeValue(
                            '--vscode-panel-border',
                            '#454545'
                        ),
                        lineColor: themeValue(
                            '--vscode-descriptionForeground',
                            '#a0a0a0'
                        ),
                        secondaryColor: themeValue(
                            '--vscode-input-background',
                            '#252526'
                        ),
                        tertiaryColor: themeValue(
                            '--vscode-editor-background',
                            '#1e1e1e'
                        ),
                    },
                });
                initialized = true;
                return true;
            } catch (_error) {
                return false;
            }
        }

        function load() {
            if (window.mermaid) {
                return Promise.resolve(initialize());
            }
            if (loadPromise) return loadPromise;
            if (!options.source) return Promise.resolve(false);
            loadPromise = new Promise(function (resolve) {
                var script = document.createElement('script');
                script.src = options.source;
                if (options.nonce) script.nonce = options.nonce;
                script.addEventListener('load', function () {
                    resolve(initialize());
                }, { once: true });
                script.addEventListener('error', function () {
                    resolve(false);
                }, { once: true });
                document.head.appendChild(script);
            });
            return loadPromise;
        }

        var INLINE_EMPHASIS_TAG = /<\/?(b|strong|i|em)(?=[\s/>])[^>]*>/gi;

        function sanitizeSource(source) {
            // Mermaid renders SVG text with htmlLabels disabled, so inline
            // emphasis tags AI providers emit would show up literally.
            return source.replace(INLINE_EMPHASIS_TAG, '');
        }

        function alt(source) {
            var summary = source.split(/\r?\n/).map(function (line) {
                return line.trim();
            }).find(function (line) {
                return line.length > 0;
            }) || 'diagram';
            return 'Mermaid diagram: ' + summary.slice(0, 120);
        }

        function normalizeSvg(svg) {
            var clean = window.DOMPurify.sanitize(svg, {
                USE_PROFILES: {
                    svg: true,
                    svgFilters: true,
                },
                FORBID_TAGS: ['foreignObject', 'script'],
                ALLOW_DATA_ATTR: false,
            });
            var documentValue = new DOMParser().parseFromString(
                clean,
                'image/svg+xml'
            );
            var root = documentValue.documentElement;
            if (!root
                || root.localName !== 'svg'
                || documentValue.querySelector('parsererror')) {
                throw new Error('Mermaid returned invalid SVG.');
            }
            var viewBox = (root.getAttribute('viewBox') || '')
                .trim()
                .split(/[\s,]+/)
                .map(Number);
            var width;
            var height;
            if (viewBox.length === 4
                && viewBox.every(Number.isFinite)
                && viewBox[2] > 0
                && viewBox[3] > 0) {
                var scale = Math.min(
                    1,
                    4096 / viewBox[2],
                    4096 / viewBox[3]
                );
                width = Math.max(1, Math.round(viewBox[2] * scale));
                height = Math.max(1, Math.round(viewBox[3] * scale));
                root.setAttribute('width', String(width));
                root.setAttribute('height', String(height));
            }
            return {
                svg: new XMLSerializer().serializeToString(root),
                width: width,
                height: height,
            };
        }

        function renderDiagram(pre, source, id) {
            var sanitized = sanitizeSource(source);
            pre.setAttribute('aria-busy', 'true');
            return Promise.resolve(window.mermaid.render(id, sanitized))
                .then(function (result) {
                    if (!pre.isConnected) return;
                    var normalized = normalizeSvg(result.svg);
                    var objectUrl = URL.createObjectURL(new Blob([
                        normalized.svg,
                    ], { type: 'image/svg+xml' }));
                    if (!pre.isConnected) {
                        URL.revokeObjectURL(objectUrl);
                        return;
                    }
                    var figure = document.createElement('figure');
                    figure.className = 'conversation-mermaid';
                    sources.set(figure, source);
                    var image = document.createElement('img');
                    image.className = 'conversation-mermaid-image';
                    if (normalized.width && normalized.height) {
                        image.width = normalized.width;
                        image.height = normalized.height;
                    }
                    image.src = objectUrl;
                    image.alt = alt(sanitized);
                    image.decoding = 'async';
                    figure.appendChild(image);
                    var decoded = typeof image.decode === 'function'
                        ? image.decode().catch(function () {})
                        : Promise.resolve();
                    return decoded.then(function () {
                        if (!pre.isConnected) {
                            URL.revokeObjectURL(objectUrl);
                            return;
                        }
                        objectUrls.push(objectUrl);
                        var readingAnchor = options.captureAnchor(pre);
                        var previousScrollTop = options.scroll.scrollTop;
                        pre.replaceWith(figure);
                        if (readingAnchor
                            && readingAnchor.element === pre) {
                            readingAnchor.element = figure;
                        }
                        options.restoreAnchor(
                            readingAnchor,
                            previousScrollTop
                        );
                    });
                })
                .catch(function () {
                    if (!pre.isConnected) return;
                    pre.removeAttribute('aria-busy');
                    pre.classList.add('conversation-mermaid-error');
                    var label = document.createElement('span');
                    label.className = 'conversation-mermaid-error-label';
                    label.setAttribute('role', 'status');
                    label.textContent =
                        'Mermaid diagram could not be rendered.';
                    var readingAnchor = options.captureAnchor();
                    var previousScrollTop = options.scroll.scrollTop;
                    pre.parentNode.insertBefore(label, pre);
                    options.restoreAnchor(readingAnchor, previousScrollTop);
                    var temporary = document.getElementById(id);
                    if (temporary) temporary.remove();
                });
        }

        function render(generation) {
            var codeBlocks = Array.prototype.slice.call(
                options.messages.querySelectorAll(
                    'pre > code.language-mermaid'
                ),
                0,
                options.maxDiagrams
            ).filter(function (code) {
                return code.parentElement
                    && code.parentElement.getAttribute('aria-busy') !== 'true';
            });
            if (!codeBlocks.length) return Promise.resolve();
            codeBlocks.forEach(function (code) {
                code.parentElement.setAttribute('aria-busy', 'true');
            });
            return load().then(function (available) {
                if (!available) {
                    codeBlocks.forEach(function (code) {
                        if (code.parentElement) {
                            code.parentElement.removeAttribute('aria-busy');
                        }
                    });
                    return;
                }
                return codeBlocks.reduce(function (promise, code, index) {
                    return promise.then(function () {
                        if (!code.parentElement
                            || !code.parentElement.isConnected) {
                            return undefined;
                        }
                        return renderDiagram(
                            code.parentElement,
                            code.textContent || '',
                            'conversation-mermaid-'
                                + generation + '-' + index
                        );
                    });
                }, Promise.resolve());
            });
        }

        function preserve(oldMessage, candidate) {
            var figuresBySource = new Map();
            var pendingBySource = new Map();
            Array.prototype.forEach.call(
                oldMessage.querySelectorAll('.conversation-mermaid'),
                function (figure) {
                    var source = sources.get(figure);
                    if (typeof source !== 'string') return;
                    var figures = figuresBySource.get(source) || [];
                    figures.push(figure);
                    figuresBySource.set(source, figures);
                }
            );
            Array.prototype.forEach.call(
                oldMessage.querySelectorAll(
                    'pre[aria-busy="true"] > code.language-mermaid'
                ),
                function (code) {
                    var source = code.textContent || '';
                    var blocks = pendingBySource.get(source) || [];
                    blocks.push(code.parentElement);
                    pendingBySource.set(source, blocks);
                }
            );
            Array.prototype.forEach.call(
                candidate.querySelectorAll('pre > code.language-mermaid'),
                function (code) {
                    var source = code.textContent || '';
                    var figures = figuresBySource.get(source);
                    var figure = figures && figures.shift();
                    if (figure && code.parentElement) {
                        code.parentElement.replaceWith(figure);
                        return;
                    }
                    var blocks = pendingBySource.get(source);
                    var block = blocks && blocks.shift();
                    if (block && code.parentElement) {
                        code.parentElement.replaceWith(block);
                    }
                }
            );
        }

        return Object.freeze({
            preserve: preserve,
            release: release,
            render: render,
        });
    }

    window.__agentPivotConversationMermaid = Object.freeze({ create: create });
})();
