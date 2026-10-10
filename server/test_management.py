"""临时数据库/随机端口管理闭环回归，不操作正式数据。"""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from urllib.request import Request, build_opener, ProxyHandler, HTTPCookieProcessor
from urllib.error import HTTPError
from http.cookiejar import CookieJar


def main():
    with tempfile.TemporaryDirectory(prefix='design-hub-management-') as directory:
        os.environ['DESIGN_HUB_DATA_DIR'] = directory
        os.environ['DESIGN_HUB_ADMIN_PASSWORD'] = 'TestAdminOnly!2026'
        os.environ['DESIGN_HUB_ADMIN_USERNAME'] = 'admin'
        spec = importlib.util.spec_from_file_location('management_app', Path(__file__).with_name('app.py'))
        app = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(app)
        app.init_database(); app.ensure_initial_admin(); app.init_database()
        class Handler(app.DesignHubHandler):
            def log_message(self, *args): pass
        server = app.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        worker = threading.Thread(target=server.serve_forever,daemon=True); worker.start()
        origin = f'http://127.0.0.1:{server.server_port}'
        class Client:
            def __init__(self):
                self.opener = build_opener(ProxyHandler({}),HTTPCookieProcessor(CookieJar()))
                self.csrf = ''
            def call(self,method,path,body=None,status=200,token=None):
                headers={'Content-Type':'application/json','X-CSRF-Token':self.csrf}
                if token: headers['Authorization']='Bearer '+token
                try:
                    response=self.opener.open(Request(origin+path,data=None if body is None else json.dumps(body).encode(),headers=headers,method=method),timeout=10)
                except HTTPError as error: response=error
                with response:
                    data=response.read()
                    assert response.status==status,(method,path,response.status,status)
                    return json.loads(data) if 'application/json' in response.headers.get('Content-Type','') else data
            def login(self,name,password='PasswordOnly!2026'):
                self.csrf=self.call('POST','/api/login',{'username':name,'password':password})['csrf_token']
        try:
            admin=Client(); admin.login('admin','TestAdminOnly!2026')
            clients={}
            for name,role in [('owner','designer'),('editor','designer'),('viewer','developer')]:
                client=Client(); client.call('POST','/api/register',{'username':name,'password':'PasswordOnly!2026','display_name':name},status=201)
                uid=next(u['id'] for u in admin.call('GET','/api/users')['users'] if u['username']==name)
                admin.call('PATCH','/api/users/'+uid,{'role':role}); client.login(name); clients[name]=(client,uid)
            owner,owner_id=clients['owner']; editor,editor_id=clients['editor']; viewer,viewer_id=clients['viewer']
            pid=owner.call('POST','/api/projects',{'name':'测试项目'},status=201)['id']; base='/api/projects/'+pid
            folder=owner.call('POST',base+'/folders',{'name':'测试目录'},status=201)['id']
            for uid,role in [(editor_id,'editor'),(viewer_id,'viewer')]: owner.call('POST',base+'/members',{'user_id':uid,'role':role})
            owner.call('POST',base+'/members',{'user_id':owner_id,'role':'viewer'},status=409)
            owner.call('PATCH',base+'/members/'+owner_id,{'role':'viewer'},status=409)
            owner.call('DELETE',base+'/members/'+owner_id,status=409)
            created=owner.call('POST','/api/api-keys',{'name':'办公室','purpose':'读取设计稿'},status=201)['api_key']; key=created['token']; kid=created['id']
            assert owner.call('GET','/api/api-keys')['api_keys'][0]['token']==key
            owner.call('PATCH','/api/api-keys/'+kid,{'name':'笔记本','purpose':'审查项目'})
            item=owner.call('GET','/api/api-keys')['api_keys'][0]
            assert (item['name'],item['purpose'],item['token'])==('笔记本','审查项目',key)
            admin.call('PATCH','/api/api-keys/'+kid,{'name':'越权'},status=404)
            owner.call('GET','/api/api-keys',token=key,status=403)
            legacy='dhk_legacy_test_only_not_a_real_key'
            with app.db_connection() as db:
                row=db.execute('SELECT * FROM api_keys WHERE id=?',(kid,)).fetchone()
                assert key not in str(dict(row))
                db.execute('INSERT INTO api_keys(id,user_id,name,token_hash,token_prefix,created_at) VALUES(?,?,?,?,?,?)',(app.uuid4(),owner_id,'旧Key',app.hash_token(legacy),legacy[:12],app.utc_now()))
            old=next(k for k in owner.call('GET','/api/api-keys')['api_keys'] if k['name']=='旧Key')
            assert not old['recoverable'] and old['token'] is None
            owner.call('GET',base,token=legacy)
            cipher=app.DATA_DIR/'.key-encryption.key'
            assert cipher.stat().st_mode & 0o777 == 0o600
            cipher.rename(app.DATA_DIR/'saved-key')
            owner.call('GET','/api/api-keys',status=503)
            assert not cipher.exists()
            (app.DATA_DIR/'saved-key').rename(cipher)
            assert next(k for k in owner.call('GET','/api/api-keys')['api_keys'] if k['id']==kid)['token']==key
            png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
            board={'sketch_id':'test','name':'测试画板','width':1,'height':1,'metadata':{},'preview_base64':png,'assets':[{'name':'a','layer_id':'a','format':'png','data_base64':png}]}
            bid=owner.call('POST',base+'/artboards/upload',{'folder_id':folder,'artboards':[board]})['results'][0]['artboard_id']
            vid=owner.call('GET','/api/artboards/'+bid)['artboard']['current_version_id']
            aid=owner.call('GET','/api/versions/'+vid)['assets'][0]['id']
            download=owner.call('POST','/api/exports/package',{'artboard_id':bid,'name':'test.zip','files':[{'name':'test.png','data_base64':png}]},status=201)['download_url']
            assert owner.call('GET',download).startswith(b'PK')
            editor.call('GET',download,status=403)
            routes=[base,base+'/folders','/api/artboards/'+bid,'/api/artboards/'+bid+'/ai-context','/api/versions/'+vid,'/api/versions/'+vid+'/preview','/api/assets/'+aid+'/download']
            editor.call('DELETE',base,status=403); viewer.call('DELETE',base,status=403)
            owner.call('DELETE',base)
            owner.call('GET',download,status=404)
            for route in routes:
                owner.call('GET',route,status=404)
                owner.call('GET',route,token=key,status=404)
            owner.call('POST',base+'/restore',{})
            assert owner.call('GET',download).startswith(b'PK')
            for route in routes: owner.call('GET',route)
            owner.call('DELETE','/api/artboards/'+bid)
            for route in routes[2:]: owner.call('GET',route,status=404)
            owner.call('POST','/api/artboards/'+bid+'/restore',{})
            owner.call('GET','/api/assets/'+aid+'/download',token=key)
            owner.call('DELETE','/api/api-keys/'+kid)
            assert not any(k['id']==kid for k in owner.call('GET','/api/api-keys')['api_keys'])
            owner.call('GET',base,token=key,status=401)
            Client().call('POST','/api/login',{'username':'owner','password':'wrong'},status=401)
            time.sleep(0.1)
            page=owner.call('GET','/api/audit?project_id='+pid+'&limit=2')
            assert len(page['logs'])==2 and page['next_cursor']
            next_page=owner.call('GET','/api/audit?project_id='+pid+'&limit=2&before='+str(page['next_cursor']))
            assert not {r['id'] for r in page['logs']} & {r['id'] for r in next_page['logs']}
            editor.call('GET','/api/audit?project_id='+pid,status=403)
            assert viewer.call('GET','/api/audit')['logs']==[]
            with app.db_connection() as db:
                logs=[dict(r) for r in db.execute('SELECT * FROM audit_logs')]
            serialized=json.dumps(logs)
            assert key not in serialized and legacy not in serialized and 'PasswordOnly!' not in serialized
            assert any(r['action']=='request.POST' and json.loads(r['details_json']).get('status')==401 for r in logs)
            assert any(r['action']=='project.delete' and r['project_id']==pid for r in logs)
            print('PASS: Key可回看/用途编辑/本人隔离/密文/旧Key/主密钥丢失/撤销；项目与画板回收直链隔离及恢复；最后Owner；日志分页权限与脱敏')
            if os.environ.get('DESIGN_HUB_TEST_UI') == '1':
                owner.call('POST','/api/api-keys',{'name':'仅测试用的Key','purpose':'浏览器回归，不用于正式环境'},status=201)
                print('ISOLATED_UI_URL='+origin,flush=True)
                time.sleep(300)
        finally:
            server.shutdown(); server.server_close(); worker.join(3)

if __name__=='__main__': main()
