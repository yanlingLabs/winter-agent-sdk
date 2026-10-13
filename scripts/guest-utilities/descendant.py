"""Fixed tool payload only. Native execution requires the separately admitted fixture."""
import os,sys,time
if len(sys.argv)!=2 or sys.argv[1] not in ('foreground','cancel'):
    raise SystemExit('fixed descendant scenario required')
scenario=sys.argv[1]
ready='descendant-ready' if scenario=='foreground' else 'cancel-ready'
orphan='descendant-orphan' if scenario=='foreground' else 'cancel-orphan'
if os.fork()==0:
    os.setsid()
    with open(ready,'w') as stream:
        stream.write('ready-after-setsid')
    time.sleep(1)
    with open(orphan,'w') as stream:
        stream.write('bad')
    os._exit(0)
deadline=time.monotonic()+2
while True:
    try:
        with open(ready) as stream:
            if stream.read()=='ready-after-setsid':
                break
    except FileNotFoundError:
        pass
    if time.monotonic()>=deadline:
        raise SystemExit('escaped child readiness timeout')
    time.sleep(.01)
if scenario=='cancel':
    time.sleep(5)
