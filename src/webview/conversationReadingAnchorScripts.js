(function () {
    'use strict';

    function create(options) {
        var scroll = options.scroll;
        var messages = options.messages;
        var messageSelector = options.messageSelector;
        var messageId = options.messageId;

        function capture(replacingElement) {
            var scrollBounds = scroll.getBoundingClientRect();
            var blockCandidates = messages.querySelectorAll(
                '.conversation-markdown > *'
            );
            var crossingBlock = null;
            for (var blockIndex = 0;
                blockIndex < blockCandidates.length;
                blockIndex += 1) {
                var blockBounds = blockCandidates[blockIndex]
                    .getBoundingClientRect();
                if (!crossingBlock
                    && blockBounds.bottom > scrollBounds.top
                    && blockBounds.top < scrollBounds.bottom) {
                    crossingBlock = blockCandidates[blockIndex];
                }
                if (blockCandidates[blockIndex] !== replacingElement
                    && blockBounds.top >= scrollBounds.top
                    && blockBounds.top < scrollBounds.bottom) {
                    var message = blockCandidates[blockIndex].closest(
                        messageSelector()
                    );
                    return {
                        element: blockCandidates[blockIndex],
                        messageId: message ? messageId(message) : null,
                        blockIndex: message
                            ? Array.prototype.indexOf.call(
                                message.querySelectorAll(
                                    '.conversation-markdown > *'
                                ),
                                blockCandidates[blockIndex]
                            )
                            : -1,
                        top: blockBounds.top - scrollBounds.top,
                        viewportTop: blockBounds.top,
                    };
                }
            }
            if (crossingBlock) {
                var crossingMessage = crossingBlock.closest(
                    messageSelector()
                );
                var crossingBounds = crossingBlock.getBoundingClientRect();
                return {
                    element: crossingBlock,
                    messageId: crossingMessage
                        ? messageId(crossingMessage)
                        : null,
                    blockIndex: crossingMessage
                        ? Array.prototype.indexOf.call(
                            crossingMessage.querySelectorAll(
                                '.conversation-markdown > *'
                            ),
                            crossingBlock
                        )
                        : -1,
                    top: crossingBounds.top - scrollBounds.top,
                    viewportTop: crossingBounds.top,
                };
            }
            var messageCandidates = messages.querySelectorAll(
                messageSelector()
            );
            for (var index = 0; index < messageCandidates.length; index += 1) {
                var bounds = messageCandidates[index].getBoundingClientRect();
                if (bounds.bottom > scrollBounds.top) {
                    return {
                        element: messageCandidates[index],
                        messageId: messageId(messageCandidates[index]),
                        top: bounds.top - scrollBounds.top,
                        viewportTop: bounds.top,
                    };
                }
            }
            return null;
        }

        function findElement(anchor) {
            if (!anchor) return null;
            if (anchor.element && anchor.element.isConnected) {
                return anchor.element;
            }
            var message = Array.prototype.find.call(
                messages.querySelectorAll(messageSelector()),
                function (candidate) {
                    return messageId(candidate) === anchor.messageId;
                }
            );
            if (!message) return null;
            if (Number.isSafeInteger(anchor.blockIndex)
                && anchor.blockIndex >= 0) {
                return message.querySelectorAll(
                    '.conversation-markdown > *'
                )[anchor.blockIndex] || message;
            }
            return message;
        }

        function restore(anchor, fallbackScrollTop) {
            scroll.scrollTop = fallbackScrollTop;
            var candidate = findElement(anchor);
            if (!candidate) return;
            var scrollBounds = scroll.getBoundingClientRect();
            var currentTop = candidate.getBoundingClientRect().top
                - scrollBounds.top;
            scroll.scrollTop += currentTop - anchor.top;
        }

        function restoreViewport(anchor, fallbackScrollTop) {
            scroll.scrollTop = fallbackScrollTop;
            var candidate = findElement(anchor);
            if (!candidate || typeof anchor.viewportTop !== 'number') return;
            scroll.scrollTop += candidate.getBoundingClientRect().top
                - anchor.viewportTop;
        }

        return Object.freeze({
            capture: capture,
            restore: restore,
            restoreViewport: restoreViewport,
        });
    }

    window.__agentPivotConversation.readingAnchor = Object.freeze({
        create: create,
    });
})();
