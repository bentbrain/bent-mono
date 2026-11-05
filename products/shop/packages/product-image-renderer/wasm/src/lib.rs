#[no_mangle]
pub extern "C" fn alloc(size: usize) -> *mut u8 {
    let mut v = vec![0; size];
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}
#[no_mangle]
pub unsafe extern "C" fn dealloc(p: *mut u8, size: usize) {
    drop(Vec::from_raw_parts(p, size, size));
}
fn sample(
    d: &[u8],
    w: usize,
    h: usize,
    x: f32,
    y: f32,
    linear: bool,
    gamma: &[f32; 256],
) -> [f32; 4] {
    let mut o = [0.; 4];
    let ix = x.floor() as i32;
    let iy = y.floor() as i32;
    let fx = x - ix as f32;
    let fy = y - iy as f32;
    for j in 0..2 {
        for i in 0..2 {
            let xx = ix + i;
            let yy = iy + j;
            if xx < 0 || xx >= w as i32 || yy < 0 || yy >= h as i32 {
                continue;
            }
            let k = (yy as usize * w + xx as usize) * 4;
            let a = d[k + 3] as f32 / 255.
                * (if i == 1 { fx } else { 1. - fx })
                * (if j == 1 { fy } else { 1. - fy });
            for c in 0..3 {
                o[c] += (if linear {
                    gamma[d[k + c] as usize]
                } else {
                    d[k + c] as f32 / 255.
                }) * a;
            }
            o[3] += a;
        }
    }
    o
}
#[no_mangle]
pub unsafe extern "C" fn displace(
    ink: *const u8,
    iw: usize,
    ih: usize,
    base: *const u8,
    map: *const u8,
    light: *const u8,
    out: *mut u8,
    tint_r: f32,
    tint_g: f32,
    tint_b: f32,
) {
    let h = 1024;
    let ink = std::slice::from_raw_parts(ink, iw * ih * 4);
    let base = std::slice::from_raw_parts(base, 768 * h * 4);
    let output = std::slice::from_raw_parts_mut(out, 768 * h * 4);
    output.copy_from_slice(base);
    let mut gamma = [0.; 256];
    for i in 0..256 {
        gamma[i] = (i as f32 / 255.).powf(2.2);
    }
    let map = std::slice::from_raw_parts(map, 768 * h * 4);
    let light = std::slice::from_raw_parts(light, 768 * h * 4);
    let tint = [tint_r.powf(2.2), tint_g.powf(2.2), tint_b.powf(2.2)];
    for k in (0..output.len()).step_by(4) {
        let coverage = light[k + 2] as f32 / 255.;
        if coverage == 0. {
            continue;
        }
        let u = (map[k] as f32 * 16. + (map[k + 1] >> 4) as f32) / 4095.;
        let v = ((map[k + 1] & 15) as f32 * 256. + map[k + 2] as f32) / 4095.;
        let p = sample(
            ink,
            iw,
            ih,
            u * iw as f32 - 0.5,
            v * ih as f32 - 0.5,
            true,
            &gamma,
        );
        let a = p[3] * coverage;
        if a == 0. {
            continue;
        }
        for c in 0..3 {
            let diffuse = (p[c] / p[3] * light[k] as f32 / 255. * 2.).min(1.);
            let lit = ((1. - (1. - diffuse) * (1. - light[k + 1] as f32 / 255.)) * tint[c]).min(1.);
            output[k + c] = ((lit * a + gamma[output[k + c] as usize] * (1. - a))
                .min(1.)
                .powf(1. / 2.2)
                * 255.)
                .round() as u8;
        }
    }
}
