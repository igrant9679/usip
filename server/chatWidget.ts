/**
 * The chat agent's install for EXTERNAL websites.
 *
 *   GET /v/chat.js          — the launcher script the customer pastes.
 *   GET /v/chat/:slug.json  — public availability + look, CORS-open.
 *
 * Mirrors /v/track.js (websiteTracking.ts): a static script string, no build
 * step, no bundle, nothing for the customer to host.
 *
 * Two decisions worth keeping:
 *
 * 1. The script asks `.json` BEFORE it renders anything. An agent that is
 *    `draft` or `off` therefore shows no bubble at all, instead of a bubble
 *    that opens onto "Chat unavailable" — a dead widget on a customer's site is
 *    worse than no widget. It also means the colour and name follow the agent's
 *    persona, so editing the persona never requires re-pasting the snippet.
 *
 * 2. The iframe is created on FIRST OPEN, not on page load. Visitors who never
 *    click cost one small cached request, not a whole chat app.
 *
 * Sizing gotcha, found by measuring rather than reading: an iframe is a REPLACED
 * element, so `width:auto` resolves to its intrinsic 300px default instead of to
 * left/right, and the `right` constraint is then dropped. The mobile rule sets an
 * explicit width for that reason — `width:auto` there looks right and renders a
 * 300px panel with a ragged gap beside it.
 */
import type { Express, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { chatAgents } from "../drizzle/schema";

const ICON_CHAT =
  `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`;
const ICON_CLOSE =
  `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`;

/**
 * ES5 on purpose — this runs on whatever browser the customer's visitors bring,
 * and it must never be the reason their page breaks (hence the outer try).
 */
export const WIDGET_JS = `(function(){try{
var s=document.currentScript||(function(){var e=document.getElementsByTagName('script');return e[e.length-1];})();
var slug=s&&s.getAttribute('data-agent');if(!slug)return;
if(window.__velocityChat)return;window.__velocityChat=1;
var base=s.src.replace(/\\/v\\/chat\\.js.*$/,'');
var side=s.getAttribute('data-position')==='left'?'left':'right';
var KEY='_vlchat_open_'+slug;
var CHAT=${JSON.stringify(ICON_CHAT)};
var CLOSE=${JSON.stringify(ICON_CLOSE)};

function mount(color,label){
var css='.vlc-b,.vlc-p{position:fixed;z-index:2147483000;'+side+':20px}'
+'.vlc-b{bottom:20px;width:56px;height:56px;border-radius:28px;border:0;padding:0;cursor:pointer;color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 24px rgba(0,0,0,.22);transition:transform .15s ease}'
+'.vlc-b:hover{transform:scale(1.06)}'
+'.vlc-p{bottom:88px;width:380px;height:560px;max-height:calc(100vh - 116px);background:#fff;border:0;border-radius:16px;overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,.24)}'
+'.vlc-hidden{display:none!important}'
+'@media(max-width:480px){.vlc-p{left:12px;right:auto;width:calc(100% - 24px);bottom:84px;height:calc(100vh - 100px)}}';
var st=document.createElement('style');st.appendChild(document.createTextNode(css));document.head.appendChild(st);

var frame=document.createElement('iframe');
frame.className='vlc-p vlc-hidden';frame.title=label;frame.setAttribute('frameborder','0');
var btn=document.createElement('button');
btn.className='vlc-b';btn.type='button';btn.style.backgroundColor=color;
btn.setAttribute('aria-label',label);btn.setAttribute('aria-expanded','false');
var open=false,loaded=false;

function render(){
btn.innerHTML=open?CLOSE:CHAT;
btn.setAttribute('aria-expanded',open?'true':'false');
if(open){
if(!loaded){loaded=true;frame.src=base+'/c/'+encodeURIComponent(slug)+'?embed=1';}
frame.className='vlc-p';
}else{frame.className='vlc-p vlc-hidden';}
try{sessionStorage.setItem(KEY,open?'1':'0');}catch(e){}
}
btn.onclick=function(){open=!open;render();};
document.addEventListener('keydown',function(e){if(open&&(e.key==='Escape'||e.keyCode===27)){open=false;render();}});
document.body.appendChild(frame);document.body.appendChild(btn);
try{if(sessionStorage.getItem(KEY)==='1')open=true;}catch(e){}
render();
}

function boot(){
var url=base+'/v/chat/'+encodeURIComponent(slug)+'.json';
if(!window.fetch)return;
window.fetch(url).then(function(r){return r.json();}).then(function(c){
if(!c||!c.ok)return;
mount(s.getAttribute('data-color')||c.themeColor||'#14B89A',s.getAttribute('data-label')||c.displayName||'Chat');
}).catch(function(){});
}
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',boot);}else{boot();}
}catch(e){}})();`;

export function registerChatWidgetRoutes(app: Express): void {
  app.get("/v/chat.js", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(200).send(WIDGET_JS);
  });

  /**
   * Availability + look. Same eligibility as `chatAgents.getPublic` — an agent
   * that is not published, or is `off`, is simply "not ok" and the script
   * renders nothing. Deliberately exposes nothing a visitor can't already see
   * by opening /c/:slug.
   */
  app.get("/v/chat/:slug.json", async (req: Request, res: Response) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=300");
    try {
      const slug = String(req.params.slug ?? "").slice(0, 80);
      const db = await getDb();
      if (!db || !slug) { res.status(200).json({ ok: false }); return; }
      const [a] = await db
        .select({
          slug: chatAgents.slug,
          status: chatAgents.status,
          mode: chatAgents.mode,
          displayName: chatAgents.displayName,
          themeColor: chatAgents.themeColor,
        })
        .from(chatAgents)
        .where(eq(chatAgents.slug, slug));
      if (!a || a.status !== "published" || a.mode === "off") {
        res.status(200).json({ ok: false });
        return;
      }
      res.status(200).json({ ok: true, displayName: a.displayName, themeColor: a.themeColor });
    } catch {
      res.status(200).json({ ok: false });
    }
  });
}
