(function () {
    'use strict';

    function capture(container, options) {
        if (!container || !options || typeof options.getKey !== 'function') return null;
        var selector = options.itemSelector;
        var items = selector && container.querySelectorAll
            ? Array.from(container.querySelectorAll(selector))
            : [];
        var containerRect = container.getBoundingClientRect();
        var anchorItem = items.find(function (item) {
            var rect = item.getBoundingClientRect();
            return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
        }) || null;
        var key = anchorItem ? options.getKey(anchorItem) : null;
        var endThreshold = Number(options.endThreshold);
        var atEnd = Number.isFinite(endThreshold)
            && endThreshold >= 0
            && container.scrollHeight - container.clientHeight - container.scrollTop <= endThreshold;
        return {
            scrollTop: Math.max(0, Number(container.scrollTop) || 0),
            itemKey: typeof key === 'string' && key ? key : null,
            itemOffset: anchorItem
                ? anchorItem.getBoundingClientRect().top - containerRect.top
                : 0,
            atEnd: atEnd,
        };
    }

    function restore(container, anchor, options) {
        if (!container || !anchor || !options || typeof options.getKey !== 'function') return false;
        if (options.followEnd && anchor.atEnd) {
            container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
            return true;
        }
        var items = options.itemSelector && container.querySelectorAll
            ? Array.from(container.querySelectorAll(options.itemSelector))
            : [];
        var item = anchor.itemKey
            ? items.find(function (candidate) {
                return options.getKey(candidate) === anchor.itemKey;
            })
            : null;
        if (item) {
            var containerTop = container.getBoundingClientRect().top;
            container.scrollTop += item.getBoundingClientRect().top
                - containerTop
                - anchor.itemOffset;
            return true;
        }
        var maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        container.scrollTop = Math.min(
            Math.max(0, Number(anchor.scrollTop) || 0),
            maxScrollTop
        );
        return true;
    }

    window.__projectStewardScrollState = Object.freeze({
        capture: capture,
        restore: restore,
    });
})();
