import { AsyncLocalStorage } from 'node:async_hooks';
const scope=new AsyncLocalStorage<{deadline:number,signal:AbortSignal}>();
export function remaining() {const state=scope.getStore();const time=state?state.deadline-Date.now():60000;if(time<=0||state?.signal.aborted) throw Error('Media query timed out');return time;}
export function signal(){return scope.getStore()?.signal;}
export async function withinDeadline<T>(task:()=>Promise<T>,milliseconds=60000,onSettled=()=>{}):Promise<T> {
 const controller=new AbortController(); let timer:ReturnType<typeof setTimeout>;
 const work=scope.run({deadline:Date.now()+milliseconds,signal:controller.signal},async()=>{try{return await task();}finally{onSettled();}});
 const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Media query timed out'));},milliseconds);});
 try{return await Promise.race([work,timeout]);}finally{clearTimeout(timer!);}
}
