"""Register only the apartment dashboard and its bundled card. Preserve other YAML."""
import pathlib,sys,re,hashlib
root=pathlib.Path(sys.argv[1]);path=root/'configuration.yaml';text=path.read_text()
bundle=pathlib.Path(__file__).resolve().parents[1]/'dist-card/apartment-hotel-card.js'
version=hashlib.sha256(bundle.read_bytes()).hexdigest()[:12]
url=f'/local/apartment-hotel/apartment-hotel-card.{version}.js'
resource=f'    - url: {url}\n      type: module\n'
dashboard='''    apartment-hotel:
      mode: yaml
      title: Apartment
      icon: mdi:floor-plan
      show_in_sidebar: true
      require_admin: false
      filename: dashboards/apartment-hotel.yaml
'''
if '/local/apartment-hotel/apartment-hotel-card' in text:
 text=re.sub(r'/local/apartment-hotel/apartment-hotel-card(?:\.[a-f0-9]{12})?\.js(?:\?[^\s]+)?',url,text)
else:
 assert '  resources:\n' in text,'Expected existing Lovelace resources'
 text=text.replace('  resources:\n','  resources:\n'+resource,1)
if '    apartment-hotel:\n' not in text:
 assert '  dashboards:\n' in text,'Expected existing Lovelace dashboards'
 text=text.replace('  dashboards:\n','  dashboards:\n'+dashboard,1)
path.write_text(text)
(root/'dashboards/apartment-hotel.yaml').write_text('''title: Apartment
views:
  - title: Apartment
    path: home
    panel: true
    cards:
      - type: custom:apartment-hotel-card
        sprite_base: /local/apartment-hotel/sprites
''')
print('Registered Apartment dashboard and local card resource.')
