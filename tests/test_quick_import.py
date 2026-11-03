import io
import unittest
from unittest.mock import patch, MagicMock
import quick_import as q
import quick_mcp

class ImportTests(unittest.TestCase):
    def test_chatgpt_file_schema(self):
        tool=next(t for t in quick_mcp.tools() if t['name']=='import_video')
        self.assertEqual(tool['_meta']['openai/fileParams'],['file'])
        schema=tool['inputSchema']['properties']['file']
        self.assertEqual(set(schema['required']),{'download_url','file_id'})
        self.assertEqual(set(schema['properties']),{'download_url','file_id','mime_type','file_name'})
        self.assertNotIn('project_id',tool['inputSchema']['properties'])
    def test_private_targets_and_schemes_rejected(self):
        for url in ['http://example.com/video','file:///tmp/video','https://user:secret@example.com/v','https://example.com:8443/v']:
            with self.subTest(url=url),self.assertRaises(ValueError):q.public_target(url)
        for ip in ['127.0.0.1','10.0.0.1','169.254.169.254','::1','::ffff:127.0.0.1']:
            with patch.object(q.socket,'getaddrinfo',return_value=[(None,None,None,None,(ip,443))]),self.assertRaises(ValueError):
                q.public_target('https://example.com/video')
    def test_public_ip_is_pinned(self):
        with patch.object(q.socket,'getaddrinfo',return_value=[(None,None,None,None,('8.8.8.8',443))]):
            target,ip=q.public_target('https://example.com/v?signature=secret')
            self.assertEqual(ip,'8.8.8.8');self.assertEqual(target.hostname,'example.com')
    def connection(self,status=200,length='3',chunks=(b'abc',b''),location=None):
        conn=MagicMock();r=conn.getresponse.return_value;r.status=status
        r.getheader.side_effect=lambda key: length if key=='Content-Length' else location
        r.read.side_effect=chunks
        return conn
    def test_pinned_tls_keeps_original_hostname_verification(self):
        context=MagicMock();sock=MagicMock()
        with patch.object(q.ssl,'create_default_context',return_value=context),patch.object(q.socket,'create_connection',return_value=sock) as connect:
            connection=q.PinnedHTTPS('attachment.example','8.8.8.8',timeout=10);connection.connect()
        connect.assert_called_once_with(('8.8.8.8',443),10)
        context.wrap_socket.assert_called_once_with(sock,server_hostname='attachment.example')
    def test_stream_cap_without_length_header(self):
        conn=self.connection(length=None,chunks=(b'abcd',b''))
        with patch.object(q,'MAX_BYTES',3),patch.object(q,'public_target',return_value=(q.urlsplit('https://example.com/v'),'8.8.8.8')),patch.object(q,'PinnedHTTPS',return_value=conn),self.assertRaises(ValueError):
            q.download('https://example.com/v',io.BytesIO())
    def test_stream_download_and_close(self):
        conn=self.connection();out=io.BytesIO()
        with patch.object(q,'public_target',return_value=(q.urlsplit('https://example.com/v'),'8.8.8.8')),patch.object(q,'PinnedHTTPS',return_value=conn):
            self.assertEqual(q.download('https://example.com/v',out),3)
        self.assertEqual(out.getvalue(),b'abc');conn.close.assert_called_once()
    def test_oversize_and_truncated_stream(self):
        for length,chunks in [('4',(b'abc',b'')),(str(q.MAX_BYTES+1),(b'',)),('3',(b'',))]:
            with self.subTest(length=length,chunks=chunks),patch.object(q,'public_target',return_value=(q.urlsplit('https://example.com/v'),'8.8.8.8')),patch.object(q,'PinnedHTTPS',return_value=self.connection(length=length,chunks=chunks)),self.assertRaises(ValueError):
                q.download('https://example.com/v',io.BytesIO())
    def test_redirect_revalidates_destination(self):
        conn=self.connection(status=302,location='https://127.0.0.1/private')
        with patch.object(q,'public_target',side_effect=[(q.urlsplit('https://example.com/v'),'8.8.8.8'),ValueError('private')]) as validate,patch.object(q,'PinnedHTTPS',return_value=conn),self.assertRaises(ValueError):
            q.download('https://example.com/v',io.BytesIO())
        self.assertEqual(validate.call_count,2);conn.close.assert_called_once()
    def test_network_error_does_not_disclose_signed_url(self):
        with patch.object(q,'download',side_effect=OSError('https://example.com/?secret=signed')):
            with self.assertRaises(ValueError) as error:q.import_attachment('http://127.0.0.1:8876',{'file_id':'file1','download_url':'https://example.com/v'})
        self.assertNotIn('secret',str(error.exception))
    def test_dispatch_import_without_existing_project(self):
        value={'project_id':'a'*32,'editor_url':'http://127.0.0.1:8876/quick?project='+'a'*32}
        with patch.object(q,'import_local',return_value=value):
            result=quick_mcp.dispatch({'id':1,'method':'tools/call','params':{'name':'import_local_video','arguments':{'source_path':'/tmp/footage.mp4'}}})
        self.assertFalse(result['result']['isError']);self.assertEqual(result['result']['structuredContent'],value)
    def test_list_projects_has_object_structured_content(self):
        with patch.object(quick_mcp,'call',return_value=[]):
            result=quick_mcp.dispatch({'id':1,'method':'tools/call','params':{'name':'list_projects'}})
        self.assertEqual(result['result']['structuredContent'],{'projects':[]})
    def test_missing_handoff_and_nonvideo_rejected(self):
        for file in [None,{}, {'file_id':'x','download_url':'https://example.com/v','mime_type':'image/jpeg'}]:
            with self.subTest(file=file),self.assertRaises(ValueError):q.import_attachment('http://127.0.0.1:8876',file)

if __name__=='__main__':unittest.main()
