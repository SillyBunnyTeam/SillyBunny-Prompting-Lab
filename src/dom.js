/**
 * Small DOM helpers with no imports, so they stay usable from every module and
 * from the browser fixture tests.
 */

export function element(tagName, {
    className = '',
    id = '',
    text = null,
    attributes = {},
} = {}) {
    const node = document.createElement(tagName);
    if (className) {
        node.className = className;
    }
    if (id) {
        node.id = id;
    }
    if (text !== null) {
        node.textContent = String(text);
    }
    for (const [name, value] of Object.entries(attributes)) {
        if (value !== null && value !== undefined) {
            node.setAttribute(name, String(value));
        }
    }
    return node;
}

export function replace(node, ...children) {
    node.replaceChildren(...children.filter(Boolean));
    return node;
}

export function button(label, onActivate, {
    className = 'menu_button sbpl-button',
    title = '',
    id = '',
} = {}) {
    const node = element('button', {
        className,
        id,
        text: label,
        attributes: {
            type: 'button',
            ...(title ? { title } : {}),
        },
    });
    if (typeof onActivate === 'function') {
        node.addEventListener('click', onActivate);
    }
    return node;
}

export function field(labelText, control, {
    className = 'sbpl-field',
    hint = '',
} = {}) {
    const wrapper = element('label', { className });
    wrapper.append(
        element('span', { className: 'sbpl-field-label', text: labelText }),
        control,
    );
    if (hint) {
        wrapper.append(element('span', { className: 'sbpl-field-hint', text: hint }));
    }
    return wrapper;
}

export function statusRegion(text = '') {
    return element('p', {
        className: 'sbpl-status',
        text,
        attributes: {
            role: 'status',
            'aria-live': 'polite',
            'aria-atomic': 'true',
        },
    });
}

export function emptyState(title, body) {
    const wrapper = element('div', { className: 'sbpl-empty' });
    wrapper.append(
        element('p', { className: 'sbpl-empty-title', text: title }),
        element('p', { className: 'sbpl-empty-body', text: body }),
    );
    return wrapper;
}

export function errorMessage(error) {
    return String(error?.message ?? error ?? 'Unknown error');
}

export function formatTokens(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString() : '0';
}
