(function () {
    'use strict';

    var HIGHLIGHT_ALL = 'conversation-find';
    var HIGHLIGHT_CURRENT = 'conversation-find-current';
    var MAX_MATCHES = 999;
    var MAX_SELECTION_QUERY = 200;

    function create(options) {
        var available = !!options.available;
        var root = options.root;
        var input = options.input;
        var count = options.count;
        var previous = options.previous;
        var next = options.next;
        var close = options.close;
        var messages = options.messages;
        var scroll = options.scroll;

        var state = {
            open: false,
            matches: [],
            currentIndex: -1,
            truncated: false,
            restoreFocus: null,
        };

        function highlightsSupported() {
            return !!(window.CSS && CSS.highlights
                && typeof Highlight === 'function');
        }

        function clearHighlights() {
            if (!highlightsSupported()) return;
            CSS.highlights.delete(HIGHLIGHT_ALL);
            CSS.highlights.delete(HIGHLIGHT_CURRENT);
        }

        function visibleText() {
            var walker = document.createTreeWalker(
                messages,
                NodeFilter.SHOW_TEXT
            );
            var records = [];
            var combined = '';
            var node;
            while ((node = walker.nextNode())) {
                if (node.parentElement
                    && node.parentElement.closest('[hidden]')) {
                    continue;
                }
                records.push({ node: node, start: combined.length });
                combined += node.nodeValue || '';
            }
            return { records: records, combined: combined };
        }

        function recordForStart(records, offset) {
            // Walk backwards so a match starting exactly on a node boundary
            // anchors inside the node its first character belongs to.
            for (var index = records.length - 1; index >= 0; index -= 1) {
                var record = records[index];
                var length = (record.node.nodeValue || '').length;
                if (offset >= record.start
                    && offset <= record.start + length) {
                    return record;
                }
            }
            return null;
        }

        function recordForEnd(records, offset) {
            for (var index = 0; index < records.length; index += 1) {
                var record = records[index];
                var length = (record.node.nodeValue || '').length;
                if (offset >= record.start
                    && offset <= record.start + length) {
                    return record;
                }
            }
            return null;
        }

        function computeMatches(query) {
            var needle = String(query || '').toLowerCase();
            if (!needle) {
                return { ranges: [], truncated: false };
            }
            var collected = visibleText();
            var haystack = collected.combined.toLowerCase();
            var ranges = [];
            var truncated = false;
            var offset = haystack.indexOf(needle);
            while (offset >= 0) {
                if (ranges.length >= MAX_MATCHES) {
                    truncated = true;
                    break;
                }
                var end = offset + needle.length;
                var startRecord = recordForStart(collected.records, offset);
                var endRecord = recordForEnd(collected.records, end);
                if (startRecord && endRecord) {
                    var range = document.createRange();
                    range.setStart(
                        startRecord.node,
                        offset - startRecord.start
                    );
                    range.setEnd(endRecord.node, end - endRecord.start);
                    ranges.push(range);
                }
                offset = haystack.indexOf(needle, offset + needle.length);
            }
            return { ranges: ranges, truncated: truncated };
        }

        function paint() {
            if (!highlightsSupported()) return;
            CSS.highlights.delete(HIGHLIGHT_ALL);
            CSS.highlights.delete(HIGHLIGHT_CURRENT);
            if (state.matches.length) {
                CSS.highlights.set(
                    HIGHLIGHT_ALL,
                    new Highlight(...state.matches)
                );
            }
            var current = state.matches[state.currentIndex];
            if (current) {
                CSS.highlights.set(
                    HIGHLIGHT_CURRENT,
                    new Highlight(current)
                );
            }
        }

        function updateCount() {
            var query = state.open && input ? input.value : '';
            if (!query) {
                count.textContent = '';
            } else if (!state.matches.length) {
                count.textContent = 'No results';
            } else {
                count.textContent = (state.currentIndex + 1)
                    + ' of '
                    + state.matches.length
                    + (state.truncated ? '+' : '');
            }
            root.classList.toggle(
                'conversation-find-no-results',
                !!query && state.matches.length === 0
            );
        }

        function scrollToCurrent() {
            var range = state.matches[state.currentIndex];
            if (!range) return;
            var bounds = range.getBoundingClientRect();
            if (!bounds || (bounds.width === 0 && bounds.height === 0)) {
                return;
            }
            var view = scroll.getBoundingClientRect();
            scroll.scrollTop += (bounds.top + bounds.bottom) / 2
                - (view.top + view.bottom) / 2;
        }

        function applyResult(result, preferredIndex, scrollToMatch) {
            state.matches = result.ranges;
            state.truncated = result.truncated;
            if (!result.ranges.length) {
                state.currentIndex = -1;
            } else {
                var clamped = Math.max(0, Math.min(
                    preferredIndex,
                    result.ranges.length - 1
                ));
                state.currentIndex = clamped;
            }
            paint();
            updateCount();
            if (scrollToMatch) scrollToCurrent();
        }

        function search() {
            applyResult(computeMatches(input.value), 0, true);
        }

        function refresh() {
            if (!available || !state.open) return;
            applyResult(computeMatches(input.value), state.currentIndex, false);
        }

        function step(direction) {
            if (!state.matches.length) return;
            state.currentIndex = (state.currentIndex + direction
                + state.matches.length) % state.matches.length;
            paint();
            updateCount();
            scrollToCurrent();
        }

        function open() {
            if (!available) return;
            if (!state.open) {
                state.restoreFocus = document.activeElement;
                state.open = true;
                root.hidden = false;
                var selection = window.getSelection();
                var selectedText = selection && !selection.isCollapsed
                    ? String(selection)
                    : '';
                if (selectedText
                    && selectedText.length <= MAX_SELECTION_QUERY
                    && messages.contains(selection.anchorNode)) {
                    input.value = selectedText;
                }
            }
            input.focus();
            input.select();
            search();
        }

        function closeFind() {
            if (!state.open) return;
            state.open = false;
            root.hidden = true;
            state.matches = [];
            state.currentIndex = -1;
            state.truncated = false;
            clearHighlights();
            updateCount();
            var target = state.restoreFocus;
            state.restoreFocus = null;
            if (target && target.isConnected
                && typeof target.focus === 'function') {
                target.focus({ preventScroll: true });
            } else {
                scroll.focus({ preventScroll: true });
            }
        }

        function handleKeydown(event) {
            if (!available) return false;
            var key = typeof event.key === 'string'
                ? event.key.toLowerCase()
                : '';
            if (key === 'f' && (event.ctrlKey || event.metaKey)
                && !event.altKey && !event.shiftKey) {
                event.preventDefault();
                open();
                return true;
            }
            if (!state.open) return false;
            if (event.key === 'Escape') {
                event.preventDefault();
                closeFind();
                return true;
            }
            if (event.key === 'Enter' && event.target === input) {
                event.preventDefault();
                step(event.shiftKey ? -1 : 1);
                return true;
            }
            return false;
        }

        function attach() {
            if (!available) return;
            input.addEventListener('input', search);
            previous.addEventListener('click', function () {
                step(-1);
            });
            next.addEventListener('click', function () {
                step(1);
            });
            close.addEventListener('click', closeFind);
        }

        return Object.freeze({
            attach: attach,
            handleKeydown: handleKeydown,
            refresh: refresh,
        });
    }

    window.__agentPivotConversationFind = Object.freeze({ create: create });
}());
