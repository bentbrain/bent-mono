"""Stage a content-addressed native card and preserve unrelated Home Assistant YAML."""
import hashlib,json,pathlib,re,shutil,sys
project=pathlib.Path(__file__).resolve().parents[1]
root=pathlib.Path(sys.argv[1]);bundle=project/'dist-card/apartment-hotel-card.js'
digest=hashlib.sha256(bundle.read_bytes()).hexdigest()[:12]
filename=f'apartment-hotel-card.{digest}.js';url=f'/local/apartment-hotel/{filename}'
config=root/'configuration.yaml';text=config.read_text()
pattern=r'/local/apartment-hotel/apartment-hotel-card(?:\.[a-f0-9]{12})?\.js(?:\?[^\s]+)?'
old=re.findall(pattern,text)
assert len(old)==1,'Expected exactly one existing apartment card resource'
if '--check' in sys.argv:
 assert old[0]==url,f'Stale release URL: {old[0]}; expected {url}'
 print('PASS: the resource URL uniquely identifies the current card build');sys.exit(0)
static=root/'www/apartment-hotel';static.mkdir(parents=True,exist_ok=True)
shutil.copy2(bundle,static/filename)
shutil.copytree(project/'public/models',static/'models',dirs_exist_ok=True)
shutil.copytree(project/'public/sprites',static/'sprites',dirs_exist_ok=True)
config.write_text(re.sub(pattern,url,text))
release={'card':filename,'url':url,'previousUrl':old[0],'sha256':hashlib.sha256(bundle.read_bytes()).hexdigest()}
(project/'dist-card/release.json').write_text(json.dumps(release,indent=2)+'\n')
print('Prepared '+url)
