"""Workspace HTTP routes, separate from the preserved legacy compatibility layer."""
import json
import re
from urllib.parse import unquote
from .core import LocalError
from .methods import criteria

def route(handler,path,query):
    workspace=handler.app.workspace;read=handler.command in {'GET','HEAD'}
    get=lambda name,default='':query.get(name,[default])[0]
    tail=path.removeprefix('/api/workspace')
    if tail=='/bootstrap' and read:return handler.send(workspace.bootstrap())
    if tail=='/import-project' and not read:return handler.send(workspace.import_project(handler.json_body()))
    if tail=='/projects':
        return handler.send({'projects':workspace.list_projects()} if read else workspace.save(handler.json_body()))
    match=re.fullmatch(r'/project-context/([A-Za-z0-9_-]+)',tail)
    if match and read:return handler.send(workspace.center.context(match[1]))
    match=re.fullmatch(r'/projects/([A-Za-z0-9_-]+)/(rename|archive|restore)',tail)
    if match and not read:return handler.send(workspace.center.transition(match[1],match[2],handler.json_body()))
    match=re.fullmatch(r'/projects/([A-Za-z0-9_-]+)',tail)
    if match:
        return handler.send(workspace.project(match[1]) if read else workspace.save(handler.json_body(),match[1]))
    if tail=='/documents':
        if read:return handler.send({'documents':workspace.documents()})
        return handler.send(workspace.store.put_document('exchange','library',handler.body(80*1024*1024),
                            unquote(handler.headers.get('X-File-Name','report.pdf'))))
    match=re.fullmatch(r'/documents/([A-Za-z0-9_-]+)(/meta)?',tail)
    if match:
        if match[2] and not read:return handler.send(workspace.metadata(match[1],handler.json_body()))
        if read:
            doc=workspace.store.document('exchange','library',match[1]);return handler.send(doc['bytes'],doc['mime'])
    if tail=='/catalog' and read:
        try: options=json.loads(get('options','{}'))
        except ValueError:raise LocalError('适用条件无效。') from None
        method=workspace.methods.resolve(get('module'),options)
        return handler.send({'method':method,'criteria':criteria(method)})
    if tail=='/methods' and read:return handler.send({'methods':workspace.methods.list()})
    if tail=='/methods/import' and not read:
        value=handler.json_body();draft=workspace.methods.draft(value['parentId'])
        return handler.send(workspace.methods.save(draft['id'],value))
    match=re.fullmatch(r'/methods/([A-Za-z0-9_-]+)(?:/(draft|validate|publish|default|diff))?',tail)
    if match:
        key,action=match.groups();methods=workspace.methods
        if read:
            if action=='diff':return handler.send({'changes':methods.diff(key)})
            bundle=methods.get(key);return handler.send({'method':bundle,'criteria':criteria(bundle)})
        data=handler.json_body()
        if action=='draft':return handler.send(methods.draft(key))
        if action=='validate':return handler.send(methods.validate(methods.get(key)))
        if action=='publish':return handler.send(methods.publish(key,data.get('acknowledged')))
        if action=='default':return handler.send(methods.set_default(key))
        return handler.send(methods.save(key,data))
    if tail=='/runs' and not read:
        data=handler.json_body();return handler.send(workspace.start(data['projectId'],data.get('retry') is True),status=202)
    match=re.fullmatch(r'/runs/([A-Za-z0-9_-]+)',tail)
    if match:
        return handler.send(workspace.run(match[1]) if read else workspace.control(match[1],handler.json_body().get('action')))
    raise LocalError('工作区接口不存在。',404)
