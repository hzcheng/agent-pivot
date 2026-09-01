(function () {
    'use strict';

    function create(options) {
        var objectUrls = [];
        var sources = new WeakMap();
        var scrollObservers = new WeakMap();
        var observedFigures = new Set();
        var initialized = false;
        var loadPromise = null;

        function figuresIn(root) {
            if (!root) return Array.from(observedFigures);
            var figures = [];
            if (root.nodeType === 1
                && root.classList.contains('conversation-mermaid')) {
                figures.push(root);
            }
            if (!root.querySelectorAll) return figures;
            return figures.concat(Array.prototype.slice.call(
                root.querySelectorAll('.conversation-mermaid')
            ));
        }

        function stopObserving(figure) {
            var observer = scrollObservers.get(figure);
            if (observer) observer.disconnect();
            scrollObservers.delete(figure);
            observedFigures.delete(figure);
        }

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
            figuresIn(root).forEach(stopObserving);
        }

        // Global release that spares the given subtrees: stashed
        // conversation frames keep their rendered figures alive while
        // everything else is revoked.
        function releaseExcept(exceptNodes) {
            var keep = new Set();
            var keepFigures = new Set();
            Array.prototype.forEach.call(exceptNodes || [], function (node) {
                if (!node || node.nodeType !== 1) return;
                figuresIn(node).forEach(function (figure) {
                    keepFigures.add(figure);
                });
                Array.prototype.forEach.call(
                    node.querySelectorAll(
                        '.conversation-mermaid-image[src^="blob:"]'
                    ),
                    function (image) {
                        keep.add(image.src);
                    }
                );
            });
            var kept = [];
            var released = [];
            objectUrls.forEach(function (url) {
                (keep.has(url) ? kept : released).push(url);
            });
            released.forEach(function (url) {
                try {
                    URL.revokeObjectURL(url);
                } catch (_error) {
                    // Revocation is best-effort during document teardown.
                }
            });
            objectUrls = kept;
            Array.from(observedFigures).forEach(function (figure) {
                if (!keepFigures.has(figure)) stopObserving(figure);
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
                var foreground = themeValue(
                    '--vscode-editor-foreground',
                    '#d4d4d4'
                );
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
                        primaryBorderColor: foreground,
                        lineColor: foreground,
                        secondaryColor: themeValue(
                            '--vscode-input-background',
                            '#252526'
                        ),
                        tertiaryColor: themeValue(
                            '--vscode-editor-background',
                            '#1e1e1e'
                        ),
                        textColor: foreground,
                        actorTextColor: foreground,
                        actorLineColor: foreground,
                        signalColor: foreground,
                        signalTextColor: foreground,
                        labelTextColor: foreground,
                        noteTextColor: foreground,
                        sequenceNumberColor: foreground,
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

        function replacementNode(pre) {
            return pre.parentElement
                && pre.parentElement.classList.contains(
                    'conversation-code-block'
                )
                ? pre.parentElement
                : pre;
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
                    var scrollLabel = 'Scrollable ' + alt(sanitized)
                        + '. Use arrow keys to view the entire diagram.';
                    var updateScrollableState = function () {
                        var scrollable = figure.scrollWidth > figure.clientWidth;
                        if (scrollable) {
                            figure.setAttribute('tabindex', '0');
                            figure.setAttribute('role', 'group');
                            figure.setAttribute('aria-label', scrollLabel);
                            return;
                        }
                        figure.removeAttribute('tabindex');
                        figure.removeAttribute('role');
                        figure.removeAttribute('aria-label');
                    };
                    figure.addEventListener('keydown', function (event) {
                        if (figure.scrollWidth <= figure.clientWidth) return;
                        if (event.key === 'ArrowLeft') {
                            figure.scrollLeft -= 40;
                        } else if (event.key === 'ArrowRight') {
                            figure.scrollLeft += 40;
                        } else if (event.key === 'Home') {
                            figure.scrollLeft = 0;
                        } else if (event.key === 'End') {
                            figure.scrollLeft = figure.scrollWidth;
                        } else {
                            return;
                        }
                        event.preventDefault();
                    });
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
                        var replacement = replacementNode(pre);
                        var readingAnchor = options.captureAnchor(replacement);
                        var previousScrollTop = options.scroll.scrollTop;
                        replacement.replaceWith(figure);
                        if (readingAnchor
                            && readingAnchor.element === replacement) {
                            readingAnchor.element = figure;
                        }
                        updateScrollableState();
                        if (typeof ResizeObserver === 'function') {
                            var resizeObserver = new ResizeObserver(function () {
                                if (!figure.isConnected) return;
                                updateScrollableState();
                            });
                            resizeObserver.observe(figure);
                            scrollObservers.set(figure, resizeObserver);
                            observedFigures.add(figure);
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
                        replacementNode(code.parentElement).replaceWith(figure);
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
            releaseExcept: releaseExcept,
            render: render,
        });
    }

    window.__agentPivotConversation.mermaid = Object.freeze({ create: create });
})();
