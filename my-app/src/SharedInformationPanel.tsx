export type SharedRecord = {recordId:string; status?:string; message?:string; kind?:string; rootWorkId?:string; groupId?:string; visibility?:string; source?:{botId:string;taskId:number;inputId:number}; version?:number; accessVersion?:number; readers?:number[]; content?:unknown; revisions?:{version:number;content:unknown;createdAt:string}[]}
export default function SharedInformationPanel({items}:{items?:SharedRecord[]}) {
 if(!items?.length)return null
  return <section aria-label="共享信息" className="task-state"><h3>共享信息</h3>{items.map(record => <article key={record.recordId}>
    {record.status ? <p role="status">{record.message}</p> : <>
      <h4>{record.kind === 'fact' ? '事实' : '笔记'}</h4>
      <p className="message-body">{typeof record.content === 'string' ? record.content : JSON.stringify(record.content)}</p>
      <a href={`#bot=${encodeURIComponent(record.source!.botId)}&task=${record.source!.taskId}`}>打开原对话</a>
    </>}
  </article>)}</section>
}
