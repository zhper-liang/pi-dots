export type SharedRecord = {recordId:string; status?:string; message?:string; kind?:string; rootWorkId?:string; groupId?:string; visibility?:string; source?:{botId:string;taskId:number;inputId:number}; version?:number; accessVersion?:number; readers?:number[]; content?:unknown; revisions?:{version:number;content:unknown;createdAt:string}[]}
export default function SharedInformationPanel({items}:{items?:SharedRecord[]}) {
 if(!items?.length)return null
  return <section aria-label="共享信息" className="task-state"><h3>共享信息</h3>{items.map(record => <article key={record.recordId}>
    {record.status ? <p role="status">{record.message}</p> : <>
      <h4>{record.kind === 'fact' ? '事实' : '笔记'}</h4>
      <p className="message-body">{typeof record.content === 'string' ? record.content : JSON.stringify(record.content)}</p>
      <a href={`#bot=${encodeURIComponent(record.source!.botId)}&task=${record.source!.taskId}`}>打开原对话</a>
      <details className="tech-info"><summary>技术信息</summary>
        <p>记录 {record.recordId} · v{record.version} · 访问版本 {record.accessVersion} · 原输入 #{record.source!.inputId} · 工作 {record.rootWorkId} · 群 {record.groupId}</p>
        <p>可读任务：{record.readers?.join('、') || '无'}</p>
        {record.revisions?.map(version => <p key={version.version}>v{version.version} · {version.createdAt} · {typeof version.content === 'string' ? version.content : JSON.stringify(version.content)}</p>)}
      </details>
    </>}
  </article>)}</section>
}
