function initFiltering(activeByDefault, dashboard) {
    const storageKey = 'filterValue';
    const hasFilterValueClass = 'has-filter-value';
    const filterInput = document.getElementById('filter');
    const clearSearchElement = document.getElementById('clear');
    const filterWrapper = filterInput.parentElement;

    function apply() {
        var filterValue = filterInput.value || '';
        filterWrapper.classList.toggle(hasFilterValueClass, filterValue.length > 0);
        sessionStorage.setItem(storageKey, filterValue);
        dashboard.setSearchQuery(filterValue);
    }

    function clear() {
        filterInput.value = '';
        sessionStorage.setItem(storageKey, '');
        filterWrapper.classList.remove(hasFilterValueClass);
        dashboard.setSearchQuery('');
        filterInput.focus();
    }

    function focus() {
        filterInput.focus();
        filterInput.select();
    }

    filterInput.addEventListener('input', apply);
    filterInput.addEventListener('change', apply);
    clearSearchElement.addEventListener('click', clear);
    window.addEventListener('keydown', event => {
        if (event.key.toLowerCase() === 'f' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            focus();
            return;
        }
        if (event.key === 'Escape' && (filterInput.value || dashboard.isSearchActive())) {
            event.preventDefault();
            clear();
        }
    });

    var storedFilter = sessionStorage.getItem(storageKey) || '';
    filterInput.value = storedFilter;
    filterWrapper.classList.toggle(hasFilterValueClass, storedFilter.length > 0);
    document.body.classList.add('filtering-active');
    if (activeByDefault && !storedFilter) {
        requestAnimationFrame(() => {
            if (typeof document.hasFocus === 'function' && document.hasFocus()) {
                focus();
            }
        });
    }

    return { clear, focus, apply };
}

function initTagFiltering() {
    var activeTags = new Set();
    var tagBar = document.querySelector('.tag-filter-bar');
    if (!tagBar) {
        return { activeTags: activeTags };
    }

    function applyTagFilter() {
        var projects = document.querySelectorAll('.project[data-id]');
        var allChip = tagBar.querySelector('[data-tag-filter="all"]');
        var tagChips = tagBar.querySelectorAll('[data-tag-filter]:not([data-tag-filter="all"])');

        if (activeTags.size === 0) {
            // No tag filter active — show all, highlight "All"
            allChip.classList.add('active');
            tagChips.forEach(function(chip) { chip.classList.remove('active'); });
            projects.forEach(function(p) { p.classList.remove('tag-filtered'); });
        } else {
            allChip.classList.remove('active');
            projects.forEach(function(p) {
                var projectTags = (p.getAttribute('data-tags') || '').toLowerCase().split(',');
                var hasAll = true;
                activeTags.forEach(function(tag) {
                    if (projectTags.indexOf(tag.toLowerCase()) === -1) {
                        hasAll = false;
                    }
                });
                p.classList.toggle('tag-filtered', !hasAll);
            });
        }
    }

    tagBar.addEventListener('click', function(e) {
        var chip = e.target.closest('.tag-filter-chip');
        if (!chip) return;

        var tag = chip.getAttribute('data-tag-filter');
        if (tag === 'all') {
            activeTags.clear();
            applyTagFilter();
            return;
        }

        if (activeTags.has(tag)) {
            activeTags.delete(tag);
            chip.classList.remove('active');
        } else {
            activeTags.add(tag);
            chip.classList.add('active');
        }
        applyTagFilter();
    });

    return { activeTags: activeTags, applyTagFilter: applyTagFilter };
}
