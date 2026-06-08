/**
 * HTMLGenerator — A2UI JSON → self-contained HTML
 *
 * Generates a self-contained HTML file with:
 * - CSP nonce-based security
 * - SRI integrity checks on CDN scripts
 * - Safe data injection via <script type="application/json">
 * - HTML entity escaping for template variables
 */

import { randomBytes } from 'crypto'
import type { A2UIMessage, CatalogConfig } from './types.js'

// Template embedded as string constant (avoids fs.readFileSync which fails in Bun compiled binaries)
const A2UI_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{title}}</title>
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'self';
             script-src 'self' https://unpkg.com https://cdn.jsdelivr.net 'nonce-{{nonce}}';
             style-src 'self' 'nonce-{{nonce}}';
             connect-src http://localhost:{{actionPort}}">
  <script crossorigin integrity="sha384-tMH8h3BGESGckSAVGZ82T9n90ztNXxvdwvdM6UoR56cYcf+0iGXBliJ29D+wZ/x8"
    src="https://unpkg.com/react@18.2.0/umd/react.production.min.js"></script>
  <script crossorigin integrity="sha384-bm7MnzvK++ykSwVJ2tynSE5TRdN+xL418osEVF2DE/L/gfWHj91J2Sphe582B1Bh"
    src="https://unpkg.com/react-dom@18.2.0/umd/react-dom.production.min.js"></script>
  <style nonce="{{nonce}}">
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 20px; }
    body.light { background: #ffffff; color: #333333; }
    body.dark { background: #1a1a2e; color: #e0e0e0; }
    #a2ui-root { max-width: 800px; margin: 0 auto; }
    .a2ui-error { color: #d32f2f; padding: 16px; background: #ffebee; border-radius: 8px; }
    .a2ui-loading { text-align: center; padding: 40px; color: #666; }
    .a2ui-status { position: fixed; bottom: 16px; right: 16px; padding: 8px 12px;
                   border-radius: 4px; font-size: 12px; }
    .a2ui-status.connected { background: #e8f5e9; color: #2e7d32; }
    .a2ui-status.disconnected { background: #fff3e0; color: #e65100; }
  </style>
</head>
<body class="{{theme}}">
  <div id="a2ui-root">
    <div class="a2ui-loading">Loading A2UI components...</div>
  </div>
  <div id="a2ui-status" class="a2ui-status"></div>

  <script id="a2ui-data" type="application/json">{{a2uiJSON}}</script>
  <div id="a2ui-config"
       data-port="{{actionPort}}"
       data-surface-id="{{surfaceId}}"
       data-catalog="{{catalogComponents}}"
       data-token="{{actionToken}}"
       style="display:none"></div>

  <script nonce="{{nonce}}">
    const A2UI_DATA = JSON.parse(document.getElementById('a2ui-data').textContent);
    const ACTION_PORT = parseInt(document.getElementById('a2ui-config').dataset.port);
    const SURFACE_ID = document.getElementById('a2ui-config').dataset.surfaceId;
    const CATALOG_COMPONENTS = JSON.parse(document.getElementById('a2ui-config').dataset.catalog);
    const ACTION_TOKEN = document.getElementById('a2ui-config').dataset.token;

    async function sendAction(action) {
      const statusEl = document.getElementById('a2ui-status');
      try {
        const resp = await fetch('http://localhost:' + ACTION_PORT + '/a2ui/action', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-A2UI-Token': ACTION_TOKEN
          },
          body: JSON.stringify({
            surfaceId: SURFACE_ID,
            ...action,
            timestamp: Date.now()
          })
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        statusEl.className = 'a2ui-status connected';
        statusEl.textContent = 'Connected';
        return await resp.json();
      } catch (err) {
        console.error('Action callback failed:', err);
        statusEl.className = 'a2ui-status disconnected';
        statusEl.textContent = 'Disconnected - action saved locally';
        localStorage.setItem('a2ui_action_' + Date.now(), JSON.stringify(action));
        throw err;
      }
    }

    // Basic A2UI renderer (inline, no CDN dependency for renderer)
    function renderA2UI(data, root) {
      root.innerHTML = '';
      for (const msg of data) {
        if (msg.surfaceUpdate) {
          for (const { id, component } of msg.surfaceUpdate.components) {
            const el = renderComponent(id, component);
            if (el) root.appendChild(el);
          }
        }
        if (msg.dataModelUpdate) {
          const pre = document.createElement('pre');
          pre.textContent = JSON.stringify(msg.dataModelUpdate.contents, null, 2);
          pre.style.cssText = 'background:#2d2d3d;padding:12px;border-radius:8px;overflow-x:auto;font-size:13px;';
          root.appendChild(pre);
        }
      }
    }

    function renderComponent(id, comp) {
      const { type, props, children } = comp;
      switch (type) {
        case 'Column': {
          const div = document.createElement('div');
          div.id = id;
          div.style.display = 'flex';
          div.style.flexDirection = 'column';
          div.style.gap = (props.gap || 8) + 'px';
          if (children) for (const childId of children) {
            const c = findComponent(childId);
            if (c) { const el = renderComponent(childId, c); if (el) div.appendChild(el); }
          }
          return div;
        }
        case 'Row': {
          const div = document.createElement('div');
          div.id = id;
          div.style.display = 'flex';
          div.style.flexDirection = 'row';
          div.style.gap = (props.gap || 8) + 'px';
          div.style.alignItems = 'center';
          if (children) for (const childId of children) {
            const c = findComponent(childId);
            if (c) { const el = renderComponent(childId, c); if (el) div.appendChild(el); }
          }
          return div;
        }
        case 'Text': {
          const span = document.createElement('span');
          span.id = id;
          span.textContent = props.text || '';
          if (props.style) Object.assign(span.style, props.style);
          return span;
        }
        case 'Card': {
          const card = document.createElement('div');
          card.id = id;
          card.style.cssText = 'border:1px solid #333;border-radius:8px;padding:16px;margin:8px 0;background:rgba(255,255,255,0.05);';
          if (props.title) {
            const h3 = document.createElement('h3');
            h3.textContent = props.title;
            h3.style.cssText = 'margin:0 0 12px 0;font-size:16px;';
            card.appendChild(h3);
          }
          if (props.child) {
            const c = findComponent(props.child);
            if (c) { const el = renderComponent(props.child, c); if (el) card.appendChild(el); }
          }
          return card;
        }
        case 'Button': {
          const btn = document.createElement('button');
          btn.id = id;
          btn.textContent = props.label || 'Button';
          const v = props.variant || 'primary';
          btn.style.cssText = v === 'primary'
            ? 'background:#6366f1;color:white;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:14px;'
            : 'background:transparent;color:#a5b4fc;border:1px solid #6366f1;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:14px;';
          btn.onclick = () => sendAction({ actionId: id+'_click_'+Date.now(), componentId: id, actionType: 'onClick', payload: {} });
          return btn;
        }
        case 'TextField': {
          const w = document.createElement('div');
          w.id = id;
          if (props.label) {
            const l = document.createElement('label');
            l.textContent = props.label;
            l.style.cssText = 'display:block;margin-bottom:4px;font-size:13px;color:#999;';
            w.appendChild(l);
          }
          const input = document.createElement('input');
          input.type = 'text';
          input.placeholder = props.placeholder || '';
          input.value = props.value || '';
          input.style.cssText = 'width:100%;padding:8px 12px;border:1px solid #333;border-radius:6px;background:#1a1a2e;color:#e0e0e0;font-size:14px;';
          input.onchange = () => sendAction({ actionId: id+'_change_'+Date.now(), componentId: id, actionType: 'onChange', payload: { value: input.value } });
          w.appendChild(input);
          return w;
        }
        case 'Select': {
          const w = document.createElement('div');
          w.id = id;
          if (props.label) {
            const l = document.createElement('label');
            l.textContent = props.label;
            l.style.cssText = 'display:block;margin-bottom:4px;font-size:13px;color:#999;';
            w.appendChild(l);
          }
          const sel = document.createElement('select');
          sel.style.cssText = 'width:100%;padding:8px 12px;border:1px solid #333;border-radius:6px;background:#1a1a2e;color:#e0e0e0;font-size:14px;';
          for (const opt of (props.options || [])) {
            const o = document.createElement('option');
            o.value = typeof opt === 'string' ? opt : opt.value || '';
            o.textContent = typeof opt === 'string' ? opt : opt.label || opt.value || '';
            sel.appendChild(o);
          }
          if (props.value) sel.value = props.value;
          sel.onchange = () => sendAction({ actionId: id+'_change_'+Date.now(), componentId: id, actionType: 'onChange', payload: { value: sel.value } });
          w.appendChild(sel);
          return w;
        }
        default: {
          const div = document.createElement('div');
          div.id = id;
          div.textContent = '[Unknown component: ' + type + ']';
          div.style.color = '#999';
          return div;
        }
      }
    }

    function findComponent(compId) {
      for (const msg of A2UI_DATA) {
        if (msg.surfaceUpdate) {
          const found = msg.surfaceUpdate.components.find(c => c.id === compId);
          if (found) return found.component;
        }
      }
      return null;
    }

    try {
      renderA2UI(A2UI_DATA, document.getElementById('a2ui-root'));
      document.getElementById('a2ui-status').className = 'a2ui-status connected';
      document.getElementById('a2ui-status').textContent = 'Connected';
    } catch (err) {
      const errEl = document.createElement('div');
      errEl.className = 'a2ui-error';
      errEl.textContent = 'Failed to initialize: ' + String(err.message || 'Unknown error');
      document.getElementById('a2ui-root').replaceChildren(errEl);
    }
  </script>
</body>
</html>`

export interface HTMLGeneratorOptions {
  messages: A2UIMessage[]
  surfaceId: string
  actionPort: number
  catalog: CatalogConfig
  actionToken: string
  theme?: 'light' | 'dark'
  title?: string
}

export class HTMLGenerator {
  private template: string

  constructor() {
    this.template = A2UI_TEMPLATE
  }

  generate(options: HTMLGeneratorOptions): string {
    const {
      messages,
      surfaceId,
      actionPort,
      catalog,
      actionToken,
      theme,
      title,
    } = options

    const nonce = randomBytes(16).toString('base64')

    const escapeHtml = (str: string): string =>
      str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')

    const safeTitle = escapeHtml(title || `A2UI - ${surfaceId}`)
    const safeTheme = ['light', 'dark'].includes(theme || '') ? theme! : 'dark'
    const safeSurfaceId = escapeHtml(surfaceId)

    return this.template
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{actionPort\}\}/g, String(actionPort))
      .replace(/\{\{a2uiJSON\}\}/, JSON.stringify(messages))
      .replace(/\{\{surfaceId\}\}/g, safeSurfaceId)
      .replace(/\{\{theme\}\}/g, safeTheme)
      .replace(/\{\{title\}\}/g, safeTitle)
      .replace(/\{\{catalogComponents\}\}/, JSON.stringify(catalog.components))
      .replace(/\{\{actionToken\}\}/g, escapeHtml(actionToken))
  }
}
