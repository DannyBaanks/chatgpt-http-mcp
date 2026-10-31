import { randomUUID } from 'node:crypto';
import type { ConversationEvent } from './journal';

// Projection only: browser text never authorizes a tool. Native calls are
// separate broker events, validated against the actual execution owner.
export class ObservedResponseProjector {
 private sequence=0;
 private started=false;
 private terminal=false;
 private text='';
 private browserMessageId?:string;
 private readonly responseId='resp_isymcp_'+randomUUID().replaceAll('-','');
 private readonly itemId='msg_isymcp_'+randomUUID().replaceAll('-','');
 constructor(private model:string){if(!model.trim())throw Error('visible_model_required');}
 private event(type:string,payload:Record<string,unknown>){return {type,...payload,sequence_number:this.sequence++};}
 private response(status:string){return {id:this.responseId,object:'response',created_at:Math.floor(Date.now()/1000),status,model:this.model,
  output:status==='in_progress'?[]:[this.item('completed')],output_text:this.text,usage:null};}
 private item(status:string){return {id:this.itemId,type:'message',status,role:'assistant',content:[{type:'output_text',text:this.text,annotations:[]}]};}
 initial():any[]{
  if(this.started)throw Error('visible_projection_already_started');this.started=true;
  return [this.event('response.created',{response:this.response('in_progress')}),this.event('response.in_progress',{response:this.response('in_progress')}),
   this.event('response.output_item.added',{output_index:0,item:{...this.item('in_progress'),content:[]}}),
   this.event('response.content_part.added',{item_id:this.itemId,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}})];
 }
 push(observed:ConversationEvent):any[]{
  if(!this.started||this.terminal)throw Error('visible_projection_terminal_or_not_started');
  if(observed.kind==='closed'){
   this.terminal=true;return [this.event('response.failed',{response:{...this.response('failed'),output:[],error:{code:'visible_browser_closed',
     message:observed.reason}}})];
  }
  if(observed.kind!=='assistant')return [];
  if(!observed.messageId||(this.browserMessageId&&this.browserMessageId!==observed.messageId))throw Error('visible_message_identity_changed');
  if(!observed.markdown.startsWith(this.text))throw Error('visible_projection_conflict');
  this.browserMessageId=observed.messageId;
  const delta=observed.markdown.slice(this.text.length);this.text=observed.markdown;
  const at={item_id:this.itemId,output_index:0,content_index:0};const events:any[]=[];
  if(delta)events.push(this.event('response.output_text.delta',{...at,delta}));
  if(observed.complete){
   this.terminal=true;const part={type:'output_text',text:this.text,annotations:[]};
   events.push(this.event('response.output_text.done',{...at,text:this.text}),this.event('response.content_part.done',{...at,part}),
    this.event('response.output_item.done',{output_index:0,item:this.item('completed')}),this.event('response.completed',
      {response:this.response('completed')}));
  }
  return events;
 }
}
