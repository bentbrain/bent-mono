"""Crop transparent sprite padding, keeping the original pixels and entire lamp."""
from PIL import Image
from pathlib import Path
root=Path(__file__).resolve().parents[1]
for name in ['okensand','gullsudare']:
 im=Image.open(root/f'public/sprites/{name}-idle-north.png').convert('RGBA');crop=im.crop(im.getbbox())
 assert crop.width<=90 and crop.height<=120
 out=Image.new('RGBA',(90,120));out.alpha_composite(crop,((90-crop.width)//2,(120-crop.height)//2));out.save(root/f'public/sprites/{name}-catalogue.png')
