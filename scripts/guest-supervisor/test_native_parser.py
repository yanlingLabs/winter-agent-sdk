"""Execute the native owner's actual bounded JSON parser with the local C compiler.
This tests parsing only, never Linux identity/confinement or privileged launch."""
import shutil,subprocess,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
class NativeParserTests(unittest.TestCase):
    def test_actual_native_parser_rejects_ambiguous_or_unbounded_core_fields(self):
        compiler=shutil.which('cc')
        if not compiler:self.skipTest('existing local C compiler unavailable')
        source=(ROOT/'packages/runtime/src/guest/linux-session-owner.c').read_text()
        # Parser is portable C; later kernel evidence checks require Linux. Compile
        # that exact source prefix rather than a reimplementation of its grammar.
        prefix=source[:source.index('static int live(')]
        harness=r'''
#include <assert.h>
static int document(const char *s,struct parser *p){memset(p,0,sizeof *p);p->s=s;p->n=(int)strlen(s);int result=parse(p,0);space(p);return result==0&&p->pos==p->n;}
int main(void){
    struct parser p;char out[16];
    assert(document("{\"runtimeUid\":20001,\"scope\":{\"sessionId\":\"backend\"},\"freshOnly\":true}",&p));
    assert(integer(&p,field(&p,0,"runtimeUid"))==20001);
    assert(!string(&p,field(&p,field(&p,0,"scope"),"sessionId"),out,sizeof out));assert(!strcmp(out,"backend"));
    assert(identifier(out));assert(!identifier("../escape"));assert(!identifier("-bad"));
    assert(document("{\"runtimeUid\":1,\"runtimeUid\":2}",&p));assert(field(&p,0,"runtimeUid")==-1);
    assert(document("{\"runtimeUid\":true}",&p));assert(integer(&p,field(&p,0,"runtimeUid"))==-1);
    assert(document("{\"sessionId\":\"back\\u0065nd\"}",&p));assert(string(&p,field(&p,0,"sessionId"),out,sizeof out)==-1);
    assert(!document("{\"n\":01}",&p));assert(!document("{\"n\":1e}",&p));assert(!document("{\"n\":tru}",&p));
    assert(!document("{\"n\":1,}",&p));assert(!document("{\"n\":1} garbage",&p));assert(!document("{\"n\":\"bad\\q\"}",&p));
    char deep[256];int count=0;for(int i=0;i<40;i++)deep[count++]='[';deep[count++]='0';for(int i=0;i<40;i++)deep[count++]=']';deep[count]=0;assert(!document(deep,&p));
    assert(document("{\"runtimeUid\":1234567890123456789012345678901234567890}",&p));assert(integer(&p,field(&p,0,"runtimeUid"))==-1);
    return 0;
}
'''
        with tempfile.TemporaryDirectory(prefix='winter-native-parser-') as directory:
            root=Path(directory);code=root/'parser.c';binary=root/'parser';code.write_text(prefix+harness)
            result=subprocess.run([compiler,'-std=c11','-O2','-Wall','-Wextra','-Werror',str(code),'-o',str(binary)],capture_output=True,text=True,timeout=30)
            self.assertEqual(result.returncode,0,result.stderr)
            result=subprocess.run([str(binary)],capture_output=True,text=True,timeout=3);self.assertEqual(result.returncode,0,result.stderr)
if __name__=='__main__':unittest.main()
