(function () {
    'use strict';

    function create(options) {
        var scroll = options.scroll;
        var messages = options.messages;
        var conversationMessageSelector = options.messageSelector;
        var conversationMessageId = options.messageId;
        var releaseMermaidObjectUrls = options.releaseMermaid;
        var preserveMermaidContent = options.preserveMermaid;
        var state = {
            followingEnd: false,
        };

        function reconcileMessages(clean, preserveUnchanged, previousSignatures) {
            var template = document.createElement('template');
            template.innerHTML = clean;
            var candidates = Array.prototype.slice.call(
                template.content.querySelectorAll(conversationMessageSelector())
            );
            var nextIds = [];
            var nextSignatures = new Map();
            candidates.forEach(function (candidate) {
                var id = conversationMessageId(candidate);
                nextIds.push(id);
                nextSignatures.set(id, candidate.outerHTML);
            });
            if (!preserveUnchanged) {
                releaseMermaidObjectUrls();
                messages.replaceChildren(template.content);
                return { ids: nextIds, signatures: nextSignatures };
            }
            var oldMessages = Array.prototype.slice.call(
                messages.querySelectorAll(conversationMessageSelector())
            );
            var unchanged = oldMessages.length === candidates.length
                && candidates.every(function (candidate, index) {
                    var id = conversationMessageId(candidate);
                    return conversationMessageId(oldMessages[index]) === id
                        && previousSignatures.get(id) === candidate.outerHTML;
                });
            if (unchanged) {
                return { ids: nextIds, signatures: nextSignatures };
            }
            var oldById = new Map();
            oldMessages.forEach(function (message) {
                var id = conversationMessageId(message);
                if (id && !oldById.has(id)) oldById.set(id, message);
            });
            var preserved = new Set();
            candidates.forEach(function (candidate) {
                var id = conversationMessageId(candidate);
                var oldMessage = oldById.get(id);
                if (!id
                    || !oldMessage
                    || preserved.has(oldMessage)) {
                    return;
                }
                if (previousSignatures.get(id) === candidate.outerHTML) {
                    preserved.add(oldMessage);
                    candidate.replaceWith(oldMessage);
                    return;
                }
                preserveMermaidContent(oldMessage, candidate);
            });
            oldMessages.forEach(function (oldMessage) {
                if (!preserved.has(oldMessage)) {
                    releaseMermaidObjectUrls(oldMessage);
                }
            });
            messages.replaceChildren(template.content);
            return { ids: nextIds, signatures: nextSignatures };
        }

        function scrollToConversationEnd() {
            scroll.scrollTop = Math.max(
                0,
                scroll.scrollHeight - scroll.clientHeight
            );
            state.followingEnd = true;
        }

        function conversationAtEnd() {
            var threshold = Number(
                document.body.getAttribute('data-auto-scroll-threshold')
            );
            return Number.isFinite(threshold)
                && threshold >= 0
                && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop
                    <= threshold;
        }

        function trackConversationEnd() {
            state.followingEnd = conversationAtEnd();
        }

        function followingConversationEnd() {
            return state.followingEnd;
        }

        function attach() {
            scroll.addEventListener('scroll', trackConversationEnd, { passive: true });
            if (typeof ResizeObserver === 'function') {
                var followObserver = new ResizeObserver(function () {
                    if (state.followingEnd) scrollToConversationEnd();
                });
                followObserver.observe(scroll);
                // The transcript growing under a reader who is following
                // the end moves the end away from them exactly like the
                // viewport shrinking does, and it happens long after the
                // page applied: images decode lazily and Mermaid diagrams
                // render asynchronously. Growth emits no scroll event, so
                // without this the physical offset silently drifts past the
                // auto-scroll threshold while the reader never moved, and
                // every later check that reads that offset — live refresh
                // follow, frame stashing — concludes they walked away.
                followObserver.observe(messages);
                window.addEventListener('unload', function () {
                    followObserver.disconnect();
                });
            }
        }

        return Object.freeze({
            attach: attach,
            atEnd: conversationAtEnd,
            followingEnd: followingConversationEnd,
            reconcile: reconcileMessages,
            scrollToEnd: scrollToConversationEnd,
            trackEnd: trackConversationEnd,
        });
    }

    window.__agentPivotConversation.reconcile = Object.freeze({ create: create });
}());
