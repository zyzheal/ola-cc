
// VSCode Extension - Claude Code
// Bundled from /Users/heal/base_branch_code/.worktrees/feature-vscode/src/vscode

"use strict";var ee=Object.create;var W=Object.defineProperty;var te=Object.getOwnPropertyDescriptor;var se=Object.getOwnPropertyNames;var oe=Object.getPrototypeOf,ie=Object.prototype.hasOwnProperty;var ne=(s,e)=>()=>(s&&(e=s(s=0)),e);var N=(s,e)=>{for(var t in e)W(s,t,{get:e[t],enumerable:!0})},V=(s,e,t,o)=>{if(e&&typeof e=="object"||typeof e=="function")for(let i of se(e))!ie.call(s,i)&&i!==t&&W(s,i,{get:()=>e[i],enumerable:!(o=te(e,i))||o.enumerable});return s};var b=(s,e,t)=>(t=s!=null?ee(oe(s)):{},V(e||!s||!s.__esModule?W(t,"default",{value:s,enumerable:!0}):t,s)),re=s=>V(W({},"__esModule",{value:!0}),s);var z={};N(z,{buildOpenAIRequest:()=>ae,parseOpenAISSE:()=>ce});function ae(s,e){let t=s.filter(n=>n.role==="system"),o=e.systemPrompt||t.map(n=>n.content).join(`

`),i=s.filter(n=>n.role!=="system"),c={model:e.model,max_tokens:e.maxTokens,temperature:e.temperature,messages:[...o?[{role:"system",content:o}]:[],...i.map(n=>({role:n.role,content:n.content}))],stream:!0};return{url:`${e.baseUrl}/v1/chat/completions`,init:{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${e.apiKey}`},body:JSON.stringify(c)}}}function ce(s){let e=s.trim();if(!e||e.startsWith(":"))return{type:"ignore"};if(!e.startsWith("data: "))return{type:"ignore"};let t=e.slice(6);if(t==="[DONE]")return{type:"done"};try{let o=JSON.parse(t),i=o.choices?.[0]?.delta?.content;return i?{type:"chunk",text:i}:o.choices?.[0]?.finish_reason?{type:"done"}:{type:"ignore"}}catch{return{type:"ignore"}}}var Y=ne(()=>{"use strict"});var we={};N(we,{activate:()=>le,deactivate:()=>fe});module.exports=re(we);var r=b(require("vscode"));var u=b(require("vscode")),M=b(require("path")),J=b(require("crypto"));var O=b(require("vscode")),m=3,de=1e3,L=1e4,U=class{constructor(e){this.abortController=null;let t=O.workspace.getConfiguration("claude");this.apiKey=e||t.get("apiKey")||process.env.ANTHROPIC_API_KEY||process.env.CLAUDE_API_KEY,this.model=t.get("model","claude-sonnet-4-20250514"),this.maxTokens=t.get("maxTokens",8192),this.temperature=t.get("temperature",0),this.baseUrl=process.env.ANTHROPIC_BASE_URL||"https://api.anthropic.com",this.provider=t.get("provider","anthropic"),this.openaiApiKey=t.get("openaiApiKey",""),this.openaiBaseUrl=t.get("openaiBaseUrl","http://localhost:11434"),this.openaiModel=t.get("openaiModel","")}onConfigChanged(){let e=O.workspace.getConfiguration("claude");this.model=e.get("model","claude-sonnet-4-20250514"),this.maxTokens=e.get("maxTokens",8192),this.temperature=e.get("temperature",0),this.provider=e.get("provider","anthropic"),this.openaiApiKey=e.get("openaiApiKey",""),this.openaiBaseUrl=e.get("openaiBaseUrl","http://localhost:11434"),this.openaiModel=e.get("openaiModel","")}async loadApiKeyFromSecretStorage(e){let t=await e.secrets.get("claude-api-key");if(t)this.apiKey=t;else{let o=O.workspace.getConfiguration("claude");this.apiKey=o.get("apiKey")||process.env.ANTHROPIC_API_KEY||process.env.CLAUDE_API_KEY}}isConfigured(){return!!this.apiKey}async streamCompletion(e,t){if(!this.isConfigured()&&this.provider==="anthropic"){t.onError(new Error('API key not configured. Set "claude.apiKey" in VSCode settings or ANTHROPIC_API_KEY environment variable.'));return}return this.provider==="openai"?this.streamOpenAI(e,t):this.streamAnthropic(e,t)}async streamAnthropic(e,t){let i=e.filter(l=>l.role==="system").map(l=>l.content).join(`

`),c=e.filter(l=>l.role!=="system"),n;for(let l=0;l<=m;l++){this.abortController?.abort(),this.abortController=new AbortController;let{signal:w}=this.abortController;try{let a=await fetch(`${this.baseUrl}/v1/messages`,{method:"POST",headers:{"Content-Type":"application/json","x-api-key":this.apiKey,"anthropic-version":"2023-06-01"},body:JSON.stringify({model:this.model,max_tokens:this.maxTokens,temperature:this.temperature,system:i,messages:c.map(v=>({role:v.role==="assistant"?"assistant":"user",content:v.content})),stream:!0}),signal:w});if(!a.ok&&(a.status===429||a.status>=500)){let v=this.getRetryAfter(a,l);if(n=new Error(`API error ${a.status}: ${await a.text()}`),l<m){await this.delay(v);continue}t.onError(new Error(`Failed after ${m} retries: ${n.message}`));return}if(!a.ok){let v=await a.text();t.onError(new Error(`API error ${a.status}: ${v}`));return}if(!a.body){t.onError(new Error("No response body from API"));return}let p=a.body.getReader(),d=new TextDecoder,g="",y=!1;for(;;){let{done:v,value:E}=await p.read();if(v)break;g+=d.decode(E,{stream:!0});let C=g.split(`
`);g=C.pop()||"";for(let S of C){let A=S.trim();if(!(!A||A.startsWith(":"))&&A.startsWith("data: ")){let T=A.slice(6);if(T==="[DONE]"){y||(y=!0,t.onComplete());return}try{let $=JSON.parse(T);this.handleStreamEvent($,t,()=>{y||(y=!0,t.onComplete())})}catch{}}}}y||(y=!0,t.onComplete());return}catch(a){if(a instanceof Error&&a.name==="AbortError")continue;if(l<m){let d=this.getRetryDelay(l);n=a instanceof Error?a:new Error(String(a)),await this.delay(d);continue}let p=a instanceof Error?a:new Error(String(a));t.onError(new Error(`Failed after ${m} retries: ${p.message}`));return}}n&&t.onError(new Error(`Failed after ${m} retries: ${n.message}`))}async streamOpenAI(e,t){let{buildOpenAIRequest:o,parseOpenAISSE:i}=await Promise.resolve().then(()=>(Y(),z)),n=e.filter(p=>p.role==="system").map(p=>p.content).join(`

`),{url:l,init:w}=o(e.map(p=>({role:p.role,content:p.content})),{baseUrl:this.openaiBaseUrl,apiKey:this.openaiApiKey||this.apiKey||"",model:this.openaiModel||this.model,maxTokens:this.maxTokens,temperature:this.temperature,systemPrompt:n}),a;for(let p=0;p<=m;p++){this.abortController?.abort(),this.abortController=new AbortController;let{signal:d}=this.abortController;try{let g=await fetch(l,{...w,signal:d});if(!g.ok&&(g.status===429||g.status>=500)){let S=this.getRetryAfter(g,p);if(a=new Error(`API error ${g.status}: ${await g.text()}`),p<m){await this.delay(S);continue}t.onError(new Error(`Failed after ${m} retries: ${a.message}`));return}if(!g.ok){t.onError(new Error(`API error ${g.status}: ${await g.text()}`));return}if(!g.body){t.onError(new Error("No response body from API"));return}let y=g.body.getReader(),v=new TextDecoder,E="",C=!1;for(;;){let{done:S,value:A}=await y.read();if(S)break;E+=v.decode(A,{stream:!0});let T=E.split(`
`);E=T.pop()||"";for(let $ of T){let K=$.trim();if(!K||K.startsWith(":")||!K.startsWith("data: "))continue;let j=i(K);if(j.type==="chunk"&&t.onChunk(j.text),j.type==="done"){C||(C=!0,t.onComplete());return}}}C||(C=!0,t.onComplete());return}catch(g){if(g instanceof Error&&g.name==="AbortError")continue;if(p<m){await this.delay(this.getRetryDelay(p));continue}t.onError(new Error(`Failed after ${m} retries: ${g}`));return}}a&&t.onError(new Error(`Failed after ${m} retries: ${a.message}`))}cancel(){this.abortController?.abort()}handleStreamEvent(e,t,o){switch(e.type){case"content_block_start":break;case"content_block_delta":{let c=e.delta;c?.type==="text_delta"&&t.onChunk(c.text);break}case"content_block_stop":break;case"message_start":break;case"message_delta":break;case"message_stop":o();break;case"ping":break;case"error":{let c=e.error;t.onError(new Error(c?.message||"Stream error"));break}}}getRetryAfter(e,t){let o=e.headers.get("Retry-After");if(o){let i=parseInt(o,10);if(!isNaN(i))return Math.min(i*1e3,L)}return this.getRetryDelay(t)}getRetryDelay(e){let t=Math.min(de*Math.pow(2,e),L),o=t*.25*(Math.random()*2-1);return Math.round(t+o)}delay(e){return new Promise(t=>setTimeout(t,e))}dispose(){this.cancel()}};var P=class{constructor(e,t,o){this.messageHistory=[];this.activeFileContext=null;this.isStreaming=!1;this.isResolving=!1;this.pendingSave=!1;this._onDidChangeVisibility=new u.EventEmitter;this.onDidChangeVisibility=this._onDidChangeVisibility.event;this.context=e,this.statusBar=t,this.client=new U(o)}static{this.viewType="claudeCode.sidebar"}resolveWebviewView(e,t,o){this.view=e,this.view.webview.options={enableScripts:!0,localResourceRoots:[u.Uri.file(M.join(this.context.extensionPath,"dist","webview"))]},this.view.webview.html=this.getWebviewHtml(),this.setupMessageHandlers(),this.isResolving=!0,this.loadSession().then(i=>{i&&(this.messageHistory=i),this.sendConfigToWebview(),this.sendHistoryToWebview(),this.isResolving=!1}).catch(()=>{this.sendConfigToWebview(),this.sendHistoryToWebview(),this.isResolving=!1})}setupMessageHandlers(){this.messageHandlerDisposable?.dispose(),this.view&&(this.messageHandlerDisposable=this.view.webview.onDidReceiveMessage(async e=>{await this.handleWebviewMessage(e)}))}async show(){this.view?.show?.(!0)}postMessage(e){this.view?.webview.postMessage(e)}onVisibilityChange(e){this._onDidChangeVisibility.fire(e)}async sendMessage(e){if(this.isStreaming)return;let t={id:q(),role:"user",content:e.content,timestamp:Date.now()};this.messageHistory.push(t),this.onMessageAdded(),this.postMessageToWebview({command:"add_message",message:t});let o=this.buildApiMessages(e);this.isStreaming=!0,this.statusBar.updateStatus("streaming");let i=q(),c="";try{await this.client.streamCompletion(o,{onChunk:n=>{c+=n,this.postMessageToWebview({command:"update_message",messageId:i,content:c,isStreaming:!0})},onComplete:()=>{let n={id:i,role:"assistant",content:c,timestamp:Date.now()};this.messageHistory.push(n),this.onMessageAdded(),this.postMessageToWebview({command:"update_message",messageId:i,content:c,isStreaming:!1}),this.isStreaming=!1,this.statusBar.updateStatus("idle")},onError:n=>{this.postMessageToWebview({command:"error",message:n.message}),this.isStreaming=!1,this.statusBar.updateStatus("error")}})}catch(n){this.isStreaming=!1,this.statusBar.updateStatus("error"),this.postMessageToWebview({command:"error",message:n instanceof Error?n.message:String(n)})}}async clearChat(){this.messageHistory=[],this.postMessageToWebview({command:"clear_messages"});try{let e=u.Uri.joinPath(this.context.globalStorageUri,"session.json");await u.workspace.fs.delete(e)}catch{}}focusInput(){this.postMessageToWebview({command:"focus_input"})}updateActiveFileContext(e){this.activeFileContext=e,this.postMessageToWebview({command:"update_file_context",context:e})}async onConfigChanged(){await this.client.loadApiKeyFromSecretStorage(this.context),this.client.onConfigChanged(),this.sendConfigToWebview()}dispose(){clearTimeout(this.saveDebounceTimer),this.messageHandlerDisposable?.dispose(),this._onDidChangeVisibility.dispose(),this.client.dispose()}async handleWebviewMessage(e){switch(e.command){case"user_message":await this.sendMessage({type:"user_message",content:e.content});break;case"apply_to_editor":this.applyToEditor(e.content);break;case"copy_to_clipboard":u.env.clipboard.writeText(e.content);break;case"open_file":this.openFile(e.path);break}}buildApiMessages(e){let t=[],o=u.workspace.getConfiguration("claude"),i=o.get("systemPrompt","");t.push({role:"system",content:i||this.getDefaultSystemPrompt()}),this.activeFileContext&&o.get("includeFileContext",!0)&&t.push({role:"system",content:`Active file: ${this.activeFileContext.path}
Language: ${this.activeFileContext.language}

Here is the current file content:
\`\`\`${this.activeFileContext.language}
${this.activeFileContext.text}
\`\`\``});let n=this.messageHistory.slice(-20);for(let l of n)l.content&&t.push({role:l.role,content:l.content});return t}applyToEditor(e){let t=u.window.activeTextEditor;if(!t){u.window.showInformationMessage("No active editor to apply changes to");return}t.edit(o=>{t.selection.isEmpty?o.insert(t.selection.start,e):o.replace(t.selection,e)})}async openFile(e){try{let t=u.Uri.file(e),o=await u.workspace.openTextDocument(t);await u.window.showTextDocument(o)}catch{u.window.showErrorMessage(`Cannot open file: ${e}`)}}postMessageToWebview(e){this.postMessage(e)}sendConfigToWebview(){let e=u.workspace.getConfiguration("claude");this.postMessageToWebview({command:"update_config",config:{showThinking:e.get("showThinking",!1),model:e.get("model","claude-sonnet-4-20250514")}})}sendHistoryToWebview(){this.postMessageToWebview({command:"load_history",messages:this.messageHistory})}async onMessageAdded(){this.saveDebounceTimer&&clearTimeout(this.saveDebounceTimer),this.messageHistory.length%10===0?(this.saveDebounceTimer=void 0,await this.saveSession()):this.saveDebounceTimer=setTimeout(()=>this.saveSession(),1e4)}async saveSession(){if(!this.pendingSave){this.pendingSave=!0;try{let e=u.Uri.joinPath(this.context.globalStorageUri,"session.json"),t=JSON.stringify({messages:this.messageHistory,savedAt:Date.now(),version:1}),o=u.Uri.joinPath(this.context.globalStorageUri,"session.json.tmp");await u.workspace.fs.writeFile(o,new TextEncoder().encode(t)),await u.workspace.fs.rename(o,e,{overwrite:!0})}finally{this.pendingSave=!1}}}async loadSession(){try{let e=u.Uri.joinPath(this.context.globalStorageUri,"session.json"),t=await u.workspace.fs.readFile(e),o=JSON.parse(new TextDecoder().decode(t));return Date.now()-o.savedAt>7*24*60*60*1e3?(await u.workspace.fs.delete(e),null):o.messages}catch{return null}}getWebviewHtml(){let e=this.view?.webview.asWebviewUri(u.Uri.file(M.join(this.context.extensionPath,"dist","webview","app.js"))),t=this.view?.webview.asWebviewUri(u.Uri.file(M.join(this.context.extensionPath,"dist","webview","highlight.js"))),o=this.view?.webview.asWebviewUri(u.Uri.file(M.join(this.context.extensionPath,"dist","webview","highlight-css.js"))),i=this.getNonce();return`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${this.view?.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${i}';">
  <title>Claude Code</title>
  <style>
    :root {
      --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --vscode-font-size: 13px;
      --vscode-editor-background: var(--vscode-editor-background, #1e1e1e);
      --vscode-editor-foreground: var(--vscode-editor-foreground, #d4d4d4);
      --vscode-sideBar-background: var(--vscode-sideBar-background, #252526);
      --vscode-input-background: var(--vscode-input-background, #3c3c3c);
      --vscode-input-foreground: var(--vscode-input-foreground, #cccccc);
      --vscode-button-background: var(--vscode-button-background, #0e639c);
      --vscode-button-foreground: var(--vscode-button-foreground, #ffffff);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body, #root { height: 100%; width: 100%; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      overflow: hidden;
    }
    #root {
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
    }
    .message {
      margin-bottom: 16px;
      line-height: 1.5;
    }
    .message.user {
      background: var(--vscode-input-background);
      border-radius: 8px;
      padding: 8px 12px;
      margin-left: 24px;
    }
    .message.assistant {
      margin-right: 24px;
    }
    .message pre {
      background: var(--vscode-sideBar-background);
      border-radius: 4px;
      padding: 8px 12px;
      overflow-x: auto;
      margin: 8px 0;
    }
    .message code {
      font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
      font-size: 12px;
    }
    .message p { margin: 8px 0; }
    .message ul, .message ol { margin: 8px 0 8px 20px; }
    .chat-input-container {
      border-top: 1px solid var(--vscode-widget-border, #454545);
      padding: 8px 12px;
      background: var(--vscode-sideBar-background);
    }
    .chat-input {
      width: 100%;
      min-height: 40px;
      max-height: 150px;
      padding: 8px 12px;
      border: 1px solid var(--vscode-widget-border, #454545);
      border-radius: 4px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      resize: vertical;
      outline: none;
    }
    .chat-input:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .chat-input::placeholder {
      color: var(--vscode-input-placeholderForeground, #888888);
    }
    .send-button {
      margin-top: 8px;
      padding: 6px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: var(--vscode-font-size);
    }
    .send-button:hover { opacity: 0.9; }
    .send-button:disabled { opacity: 0.5; cursor: not-allowed; }
    .typing-indicator { color: var(--vscode-descriptionForeground, #888); font-style: italic; }
    .file-context-badge {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
      padding: 4px 8px;
      background: var(--vscode-badge-background, #4d4d4d);
      border-radius: 12px;
      margin-bottom: 8px;
      display: inline-block;
    }
    .welcome-screen {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      color: var(--vscode-descriptionForeground, #888);
      padding: 24px;
    }
    .welcome-screen h2 {
      font-size: 20px;
      color: var(--vscode-editor-foreground);
      margin-bottom: 12px;
    }
    .welcome-screen p { margin: 4px 0; }
    .suggestions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
      margin-top: 16px;
    }
    .suggestion-btn {
      padding: 6px 12px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-widget-border, #454545);
      border-radius: 16px;
      color: var(--vscode-input-foreground);
      cursor: pointer;
      font-size: 12px;
    }
    .suggestion-btn:hover {
      background: var(--vscode-list-hoverBackground, #2a2d2e);
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${i}" src="${t}"></script>
  <script nonce="${i}" src="${o}"></script>
  <script nonce="${i}" src="${e}"></script>
</body>
</html>`}getNonce(){return J.randomUUID().replace(/-/g,"")}getDefaultSystemPrompt(){return`You are Claude Code, an AI coding assistant integrated into VSCode. You help developers with:

- **Code Explanation**: Breaking down complex code into understandable parts
- **Refactoring**: Improving code quality, readability, and maintainability
- **Debugging**: Identifying and fixing bugs and issues
- **Test Generation**: Writing comprehensive unit and integration tests
- **Code Review**: Providing feedback on best practices and potential improvements
- **General Coding**: Answering questions and providing guidance

Guidelines:
- Be concise and direct
- Use code examples when helpful
- Explain your reasoning briefly
- Respect the user's existing code style
- When suggesting changes, provide the full updated code block`}};function q(){return"msg_"+Math.random().toString(36).substring(2,15)+Date.now().toString(36)}var h=b(require("vscode")),I=class{static{this.providedCodeActionKinds=[h.CodeActionKind.Refactor,h.CodeActionKind.QuickFix]}provideCodeActions(e,t,o){let i=[];if(t.isEmpty)return i;let c=this.createAction(e,t,"Explain with Claude","claude.explain",h.CodeActionKind.Refactor);i.push(c);let n=this.createAction(e,t,"Refactor with Claude","claude.refactor",h.CodeActionKind.Refactor);if(i.push(n),o.diagnostics.length>0){let a=this.createAction(e,t,"Fix with Claude","claude.fix",h.CodeActionKind.QuickFix);i.push(a)}let l=this.createAction(e,t,"Generate Tests with Claude","claude.generateTests",h.CodeActionKind.Refactor);i.push(l);let w=this.createAction(e,t,"Review with Claude","claude.review",h.CodeActionKind.Refactor);return i.push(w),i}createAction(e,t,o,i,c){let n=new h.CodeAction(o,c);return n.command={command:i,title:o,arguments:[e,t]},n}};var k=b(require("vscode")),G=500,_=class{constructor(){this.recentHovers=new Map;this.HOVER_COOLDOWN_MS=5e3}async provideHover(e,t){if(!k.workspace.getConfiguration("claude").get("enableHoverInsights",!1))return;this.recentHovers.size>=G&&this.evictStaleEntries();let i=e.getWordRangeAtPosition(t);if(!i)return;let c=e.getText(i);if(!c||c.length<3)return;let n=`${e.uri.toString()}:${c}:${i.start.line}`,l=this.recentHovers.get(n);if(l&&Date.now()-l<this.HOVER_COOLDOWN_MS)return;this.recentHovers.set(n,Date.now());let a=e.lineAt(t.line).text.trim(),p=new k.MarkdownString;return p.appendText(`Quick insight for "${c}"`),p.appendMarkdown(`

---
`),p.appendText(a),p.appendMarkdown(`

`),p.appendMarkdown("[Ask Claude for explanation](command:claude.explain)"),p.isTrusted=!0,new k.Hover(p)}evictStaleEntries(){let e=Date.now();for(let[t,o]of this.recentHovers)e-o>this.HOVER_COOLDOWN_MS&&this.recentHovers.delete(t);if(this.recentHovers.size>=G){let t=Array.from(this.recentHovers.entries()).sort((i,c)=>i[1]-c[1]),o=t.slice(0,t.length/2);for(let[i]of o)this.recentHovers.delete(i)}}};var f=b(require("vscode")),F=class{constructor(e){this.statusBarItem=f.window.createStatusBarItem(f.StatusBarAlignment.Right,100),this.statusBarItem.tooltip="Claude Code - AI Coding Assistant",this.statusBarItem.command="claude.chat",this.updateStatus("ready"),this.statusBarItem.show(),e.subscriptions.push(this.statusBarItem)}updateStatus(e){switch(e){case"idle":this.statusBarItem.text="$(comment-discussion) Claude",this.statusBarItem.color=void 0;break;case"streaming":this.statusBarItem.text="$(loading~spin) Claude",this.statusBarItem.color=new f.ThemeColor("statusBarItem.warningForeground"),this.statusBarItem.backgroundColor=new f.ThemeColor("statusBarItem.warningBackground");break;case"error":this.statusBarItem.text="$(error) Claude",this.statusBarItem.color=new f.ThemeColor("statusBarItem.errorForeground"),this.statusBarItem.backgroundColor=new f.ThemeColor("statusBarItem.errorBackground");break;case"ready":this.statusBarItem.text="$(comment-discussion) Claude",this.statusBarItem.color=new f.ThemeColor("statusBarItem.prominentForeground");break}}dispose(){this.statusBarItem.dispose()}};var R,B,Q,x,H;async function X(s,e){try{if(await s.secrets.store("claude-api-key",e),!await s.secrets.get("claude-api-key"))throw new Error("SecretStorage read-back failed");return!0}catch{return await r.workspace.getConfiguration("claude").update("apiKey",e,r.ConfigurationTarget.Global),r.window.showWarningMessage("SecretStorage unavailable. API key stored in settings.json (not encrypted)."),!1}}async function ue(s){let e=await s.secrets.get("claude-api-key");return e||r.workspace.getConfiguration("claude").get("apiKey")}async function pe(s){let e=r.workspace.getConfiguration("claude"),t=e.get("apiKey","");t&&await X(s,t)&&(await e.update("apiKey","",r.ConfigurationTarget.Global),console.log("API key migrated from settings.json to SecretStorage"))}async function le(s){console.log("Claude Code extension activated"),B=new F(s),B.updateStatus("idle"),await pe(s);let e=await ue(s),t=new P(s,B,e);s.subscriptions.push(r.window.registerWebviewViewProvider(P.viewType,t)),R=t,ge(s,R),me(s),ve(s,R)}function ge(s,e){let t=r.commands.registerCommand("claude.chat",async()=>{await e.show(),e.focusInput()});s.subscriptions.push(t);let o=r.commands.registerCommand("claude.explain",async()=>{let d=D();await e.show(),e.sendMessage({type:"user_message",content:`Please explain this code:

\`\`\`${d.language}
${d.text}
\`\`\``,context:d})});s.subscriptions.push(o);let i=r.commands.registerCommand("claude.refactor",async()=>{let d=D();await e.show(),e.sendMessage({type:"user_message",content:`Please refactor this code to improve readability and maintainability:

\`\`\`${d.language}
${d.text}
\`\`\``,context:d})});s.subscriptions.push(i);let c=r.commands.registerCommand("claude.fix",async()=>{let d=D();await e.show(),e.sendMessage({type:"user_message",content:`Please identify and fix any issues in this code:

\`\`\`${d.language}
${d.text}
\`\`\``,context:d})});s.subscriptions.push(c);let n=r.commands.registerCommand("claude.generateTests",async()=>{let d=D();await e.show(),e.sendMessage({type:"user_message",content:`Please generate comprehensive unit tests for this code:

\`\`\`${d.language}
${d.text}
\`\`\``,context:d})});s.subscriptions.push(n);let l=r.commands.registerCommand("claude.review",async()=>{let d=D();await e.show(),e.sendMessage({type:"user_message",content:`Please review this code for best practices, potential bugs, and improvements:

\`\`\`${d.language}
${d.text}
\`\`\``,context:d})});s.subscriptions.push(l);let w=r.commands.registerCommand("claude.clearChat",()=>{e.clearChat()});s.subscriptions.push(w);let a=r.commands.registerCommand("claude.focusInput",async()=>{await e.show(),e.focusInput()});s.subscriptions.push(a);let p=r.commands.registerCommand("claude.setApiKey",async()=>{let d=await r.window.showInputBox({prompt:"Enter your Anthropic API key",password:!0,ignoreFocusOut:!0});d&&await X(s,d)&&(r.window.showInformationMessage("API key saved securely."),R?.onConfigChanged())});s.subscriptions.push(p)}function me(s){let e=new I;Q=r.languages.registerCodeActionsProvider({pattern:"**/*.{ts,tsx,js,jsx,py,go,rs,rb,java,c,cpp,h,hpp}"},e,{providedCodeActionKinds:I.providedCodeActionKinds}),s.subscriptions.push(Q),r.workspace.getConfiguration("claude").get("enableHoverInsights",!1)&&(H=new _,x=r.languages.registerHoverProvider({pattern:"**/*"},H),s.subscriptions.push(x))}function ve(s,e){s.subscriptions.push(r.workspace.onDidChangeConfiguration(t=>{t.affectsConfiguration("claude")&&(e.onConfigChanged(),B?.updateStatus("idle"),t.affectsConfiguration("claude.enableHoverInsights")&&he(s))})),s.subscriptions.push(r.window.onDidChangeActiveTextEditor(t=>{t&&e.updateActiveFileContext({path:t.document.uri.fsPath,language:t.document.languageId,text:Z(t),selection:t.selection.isEmpty?null:t.selection})})),s.subscriptions.push(r.window.onDidChangeTextEditorSelection(t=>{t.textEditor.document.uri.scheme==="file"&&!t.selections[0]?.isEmpty&&e.updateActiveFileContext({path:t.textEditor.document.uri.fsPath,language:t.textEditor.document.languageId,text:t.textEditor.document.getText(t.selections[0]),selection:t.selections[0]})}))}function he(s){let t=r.workspace.getConfiguration("claude").get("enableHoverInsights",!1);t&&!x?(H=new _,x=r.languages.registerHoverProvider({pattern:"**/*"},H),s.subscriptions.push(x)):!t&&x&&(x.dispose(),x=void 0,H=void 0)}function D(){let s=r.window.activeTextEditor;return s?{language:s.document.languageId,text:Z(s),path:s.document.uri.fsPath,selection:s.selection.isEmpty?null:s.selection}:{language:"text",text:"",path:"",selection:null}}function Z(s){return r.workspace.getConfiguration("claude").get("includeSelectionOnly",!0)&&!s.selection.isEmpty?s.document.getText(s.selection):s.document.getText()}function fe(){R?.dispose(),B?.dispose(),console.log("Claude Code extension deactivated")}0&&(module.exports={activate,deactivate});
