import * as THREE from "three";

/**
 * Direct WebGL2 (#version 300 es) port of OrcaSlicer 2.5.0's official 3D viewport shaders:
 * - phong.vs / phong.fs (studio_shade + classic 2-light Phong + circular softbox window reflection)
 * - gouraud_light.vs / hotbed.fs (official 3D bed plate STL & hotend shading)
 * - ssao.fs (12-tap slope-based depth SSAO — darkens valleys/creases cleanly, ignores background)
 * - fxaa.fs (fast edge anti-aliasing after SSAO)
 */

export type OrcaLightingModel = "studio" | "classic";

export interface OrcaViewportRenderConfig {
  lightingModel: OrcaLightingModel;
  ssaoEnabled: boolean;
  shadowsEnabled: boolean;
}

const RENDER_CONFIG_KEY = "orca-viewport-render-config-v1";

export function loadViewportRenderConfig(): OrcaViewportRenderConfig {
  try {
    const raw = localStorage.getItem(RENDER_CONFIG_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<OrcaViewportRenderConfig>;
      return {
        lightingModel: p.lightingModel === "classic" ? "classic" : "studio",
        ssaoEnabled: p.ssaoEnabled !== false,
        shadowsEnabled: p.shadowsEnabled !== false,
      };
    }
  } catch {
    // ignore
  }
  return { lightingModel: "studio", ssaoEnabled: true, shadowsEnabled: true };
}

export function saveViewportRenderConfig(cfg: OrcaViewportRenderConfig) {
  try {
    localStorage.setItem(RENDER_CONFIG_KEY, JSON.stringify(cfg));
  } catch {
    // ignore
  }
}

// ==================== 1. ORCASLICER MODEL SHADER (phong.vs / phong.fs) ====================

const ORCA_MODEL_VS = /* glsl */ `
precision highp float;

attribute vec3 color;

varying vec3 vColor;
varying vec3 vEyeNormal;
varying vec3 vEyePosition;
varying vec3 vWorldPos;

void main() {
  vColor = color;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  vec4 eyePos = viewMatrix * worldPos;
  vEyePosition = eyePos.xyz;
  vEyeNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * eyePos;
}
`;

const ORCA_MODEL_FS = /* glsl */ `
precision highp float;

#define INTENSITY_CORRECTION 0.6
const vec3 LIGHT_TOP_DIR = vec3(-0.4574957, 0.4574957, 0.7624929);
#define LIGHT_TOP_DIFFUSE    (0.85 * INTENSITY_CORRECTION)
#define LIGHT_TOP_SPECULAR   (0.35 * INTENSITY_CORRECTION)
#define LIGHT_TOP_SHININESS  32.0

const vec3 LIGHT_FRONT_DIR = vec3(0.6985074, 0.1397015, 0.6985074);
#define LIGHT_FRONT_DIFFUSE  (0.35 * INTENSITY_CORRECTION)
#define LIGHT_FRONT_SPECULAR (0.12 * INTENSITY_CORRECTION)
#define LIGHT_FRONT_SHININESS 16.0
#define INTENSITY_AMBIENT    0.26

uniform int uLightingModel; // 1 = Orca studio_shade, 0 = Orca classic 2-light Phong + window reflection
uniform vec3 uWorldUpEye;
uniform vec3 uBuildVolume;
uniform float uSelected;
uniform float uOpacity;
uniform vec3 uOverrideColor;
uniform float uUseOverrideColor;

varying vec3 vColor;
varying vec3 vEyeNormal;
varying vec3 vEyePosition;
varying vec3 vWorldPos;

float soft_circle(vec2 p, vec2 center, float radius, float blur) {
  float dist = distance(p, center);
  return 1.0 - smoothstep(radius - blur, radius, dist);
}

// Direct port of OrcaSlicer phong.fs compute_window_reflection()
vec3 compute_window_reflection(vec3 normal, vec3 view_dir) {
  vec3 light_dir = normalize(LIGHT_TOP_DIR);
  vec3 reflect_light = normalize(reflect(-light_dir, normal));
  vec2 uv = (reflect_light.xy / (1.0 + max(reflect_light.z, 0.3))) * 2.2;
  vec2 grad = fwidth(uv) * 0.8;
  float blur = 0.12 + grad.x * 1.5;
  float window_light = soft_circle(uv, vec2(0.0), 0.5, blur);
  float fresnel = pow(1.0 - max(dot(normal, view_dir), 0.0), 1.2);
  float facing = smoothstep(-0.4, 0.6, reflect_light.z);
  float intensity = clamp(window_light * (0.15 + 0.15 * fresnel) * facing, 0.0, 0.25);
  return vec3(intensity);
}

// Direct port of OrcaSlicer 2.5.0 phong.fs studio_shade()
vec3 studio_shade(vec3 base, vec3 n, vec3 v) {
  vec3 key  = normalize(vec3(-0.45, 0.60, 0.66));
  vec3 fill = normalize(vec3(0.70, -0.15, 0.70));
  float hemi = 0.5 + 0.5 * dot(n, normalize(uWorldUpEye));
  vec3 ambient = mix(vec3(0.18, 0.17, 0.16), vec3(0.42, 0.44, 0.48), hemi);
  float kd = max(dot(n, key), 0.0);
  float fd = max(dot(n, fill), 0.0);
  vec3 diffuse = ambient + vec3(0.60) * kd + vec3(0.20) * fd;
  float spec = 0.26 * pow(max(dot(n, normalize(key + v)), 0.0), 48.0)
             + 0.06 * pow(max(dot(n, normalize(fill + v)), 0.0), 24.0);
  float rim = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 3.0);
  return base * diffuse * (1.0 - 0.28 * rim) + vec3(spec + 0.08 * rim);
}

void main() {
  vec3 base = mix(vColor, uOverrideColor, uUseOverrideColor);

  // OrcaSlicer out-of-build-volume darkening (matches phong.fs print_volume check)
  bool oob = vWorldPos.x < -0.5 || vWorldPos.x > uBuildVolume.x + 0.5
          || vWorldPos.y < -0.5 || vWorldPos.y > uBuildVolume.y + 0.5
          || vWorldPos.z < -0.5 || vWorldPos.z > uBuildVolume.z + 0.5;
  if (oob) {
    base = mix(base, vec3(0.0), 0.3333);
  }

  vec3 normal = normalize(vEyeNormal);
  if (!gl_FrontFacing) normal = -normal;
  vec3 view_dir = normalize(-vEyePosition);

  vec3 lit;
  if (uLightingModel == 1) {
    lit = studio_shade(base, normal, view_dir);
  } else {
    float NdotL_top = max(dot(normal, LIGHT_TOP_DIR), 0.0);
    float diffuse = INTENSITY_AMBIENT + NdotL_top * LIGHT_TOP_DIFFUSE;
    vec3 half_top = normalize(LIGHT_TOP_DIR + view_dir);
    float specular = LIGHT_TOP_SPECULAR * pow(max(dot(normal, half_top), 0.0), LIGHT_TOP_SHININESS);

    float NdotL_front = max(dot(normal, LIGHT_FRONT_DIR), 0.0);
    diffuse += NdotL_front * LIGHT_FRONT_DIFFUSE;
    vec3 half_front = normalize(LIGHT_FRONT_DIR + view_dir);
    specular += LIGHT_FRONT_SPECULAR * pow(max(dot(normal, half_front), 0.0), LIGHT_FRONT_SHININESS);
    vec3 window_reflection = compute_window_reflection(normal, view_dir);
    lit = vec3(specular) + window_reflection + base * diffuse;
  }

  // Subtle selection Fresnel rim highlight (preserves form & shading unlike flat emissive)
  if (uSelected > 0.5) {
    float selRim = pow(1.0 - clamp(dot(normal, view_dir), 0.0, 1.0), 2.4);
    lit += vec3(0.22, 0.72, 0.98) * (0.28 * selRim + 0.03);
  }

  gl_FragColor = vec4(clamp(lit, 0.0, 1.0), uOpacity);
}
`;

export function hexToSrgbRgb(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n)) return [0.13, 0.77, 0.37];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function createOrcaModelMaterial(opts: {
  lightingModel: OrcaLightingModel;
  buildVolume: [number, number, number];
  selected?: boolean;
  wireframe?: boolean;
  opacity?: number;
  overrideHex?: string;
}): THREE.ShaderMaterial {
  const transparent = (opts.opacity ?? 1) < 0.999;
  const ov = opts.overrideHex ? hexToSrgbRgb(opts.overrideHex) : [1, 1, 1];
  return new THREE.ShaderMaterial({
    vertexShader: ORCA_MODEL_VS,
    fragmentShader: ORCA_MODEL_FS,
    wireframe: Boolean(opts.wireframe),
    transparent,
    depthWrite: !transparent,
    side: THREE.DoubleSide,
    uniforms: {
      uLightingModel: { value: opts.lightingModel === "studio" ? 1 : 0 },
      uWorldUpEye: { value: new THREE.Vector3(0, 1, 0) },
      uBuildVolume: { value: new THREE.Vector3(opts.buildVolume[0], opts.buildVolume[1], opts.buildVolume[2]) },
      uSelected: { value: opts.selected ? 1.0 : 0.0 },
      uOpacity: { value: opts.opacity ?? 1.0 },
      uOverrideColor: { value: new THREE.Vector3(ov[0], ov[1], ov[2]) },
      uUseOverrideColor: { value: opts.overrideHex ? 1.0 : 0.0 },
    },
  });
}

// ==================== 2. ORCASLICER HOTBED / HOTEND SHADER (gouraud_light.vs / hotbed.fs) ====================

const ORCA_HOTBED_VS = /* glsl */ `
precision highp float;

#define INTENSITY_CORRECTION 0.6
const vec3 LIGHT_TOP_DIR = vec3(-0.4574957, 0.4574957, 0.7624929);
#define LIGHT_TOP_DIFFUSE    (0.8 * INTENSITY_CORRECTION)
#define LIGHT_TOP_SPECULAR   (0.14 * INTENSITY_CORRECTION)
#define LIGHT_TOP_SHININESS  20.0

const vec3 LIGHT_FRONT_DIR = vec3(0.6985074, 0.1397015, 0.6985074);
#define LIGHT_FRONT_DIFFUSE  (0.3 * INTENSITY_CORRECTION)
#define INTENSITY_AMBIENT    0.34

varying vec2 vIntensity;

void main() {
  vec3 n = normalize(normalMatrix * normal);
  float ndlTop = max(dot(n, LIGHT_TOP_DIR), 0.0);
  vIntensity.x = INTENSITY_AMBIENT + ndlTop * LIGHT_TOP_DIFFUSE;
  vec4 pos = modelViewMatrix * vec4(position, 1.0);
  vIntensity.y = LIGHT_TOP_SPECULAR * pow(max(dot(-normalize(pos.xyz), reflect(-LIGHT_TOP_DIR, n)), 0.0), LIGHT_TOP_SHININESS);
  float ndlFront = max(dot(n, LIGHT_FRONT_DIR), 0.0);
  vIntensity.x += ndlFront * LIGHT_FRONT_DIFFUSE;
  gl_Position = projectionMatrix * pos;
}
`;

const ORCA_HOTBED_FS = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uEmission;
varying vec2 vIntensity;

void main() {
  vec3 rgb = vec3(vIntensity.y) + uColor * (vIntensity.x + uEmission);
  gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
`;

export function createOrcaHotbedMaterial(colorHex: string, emission = 0.06, polygonOffset = true): THREE.ShaderMaterial {
  const [r, g, b] = hexToSrgbRgb(colorHex);
  return new THREE.ShaderMaterial({
    vertexShader: ORCA_HOTBED_VS,
    fragmentShader: ORCA_HOTBED_FS,
    polygonOffset,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
    uniforms: {
      uColor: { value: new THREE.Vector3(r, g, b) },
      uEmission: { value: emission },
    },
  });
}

// ==================== 3. ORCASLICER SSAO + FXAA POST-PROCESS PIPELINE ====================

const FULLSCREEN_VS = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Direct WebGL2 port of OrcaSlicer 2.5.0 /resources/shaders/140/ssao.fs
const ORCA_SSAO_FS = /* glsl */ `
precision highp float;
precision highp int;

uniform sampler2D uColorTex;
uniform sampler2D uDepthTex;
uniform vec2 uInvTexSize;
uniform float uZFar;
uniform mat4 uInvProjection;
uniform vec3 uUpView;
uniform int uEnableSSAO;

in vec2 vUv;
out vec4 fragColor;

vec3 view_pos(ivec2 pixel, ivec2 texSize) {
  ivec2 p = clamp(pixel, ivec2(0), texSize - 1);
  float d = texelFetch(uDepthTex, p, 0).r;
  vec4 ndc = vec4((vec2(p) + 0.5) * uInvTexSize * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 view = uInvProjection * ndc;
  return view.xyz / view.w;
}

vec3 view_normal(ivec2 pixel, vec3 p, ivec2 texSize) {
  vec3 px = view_pos(pixel + ivec2(1, 0), texSize);
  vec3 py = view_pos(pixel + ivec2(0, 1), texSize);
  vec3 n = cross(px - p, py - p);
  float len = length(n);
  return (len > 1e-8) ? n / len : vec3(0.0, 0.0, 1.0);
}

void main() {
  vec3 color = texture(uColorTex, vUv).rgb;
  if (uEnableSSAO == 0) {
    fragColor = vec4(color, 1.0);
    return;
  }

  ivec2 texSize = textureSize(uDepthTex, 0);
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  float centerD = texelFetch(uDepthTex, clamp(pixel, ivec2(0), texSize - 1), 0).r;

  // Skip empty background pixels so the viewport gradient is never darkened
  if (centerD >= 0.9999) {
    fragColor = vec4(color, 1.0);
    return;
  }

  vec3 center_pos = view_pos(pixel, texSize);
  float center_depth = -center_pos.z;
  vec3 normal_center = view_normal(pixel, center_pos, texSize);
  float up_factor = clamp(dot(normal_center, uUpView), 0.0, 1.0);

  int radius = int(mix(2.0, 4.0, clamp(center_depth / uZFar, 0.0, 1.0)));

  const int SAMPLE_COUNT = 12;
  const ivec2 offsets[SAMPLE_COUNT] = ivec2[](
    ivec2(1, 0),  ivec2(-1, 0),  ivec2(0, 1),  ivec2(0, -1),
    ivec2(1, 1),  ivec2(-1, 1),  ivec2(1, -1), ivec2(-1, -1),
    ivec2(2, 0),  ivec2(-2, 0),  ivec2(0, 2),  ivec2(0, -2)
  );

  const float SLOPE_MIN = 0.08;
  const float SLOPE_MAX = 0.60;

  float occlusion = 0.0;
  for (int i = 0; i < SAMPLE_COUNT; i++) {
    ivec2 sample_pixel = pixel + offsets[i] * radius;
    vec3 delta = view_pos(sample_pixel, texSize) - center_pos;
    float dist = length(delta);
    float rise = (dist > 1e-6) ? dot(delta, normal_center) / dist : 0.0;
    if (rise > SLOPE_MIN) {
      float c = clamp((rise - SLOPE_MIN) / (SLOPE_MAX - SLOPE_MIN), 0.0, 1.0);
      occlusion += c * c;
    }
  }

  float ao_factor = 1.0 - (occlusion / float(SAMPLE_COUNT)) * 0.62;
  float ao_min = mix(0.48, 0.72, up_factor);
  float finalAo = clamp(ao_factor, ao_min, 1.0);
  fragColor = vec4(color * finalAo, 1.0);
}
`;

// Direct WebGL2 port of OrcaSlicer 2.5.0 /resources/shaders/140/fxaa.fs
const ORCA_FXAA_FS = /* glsl */ `
precision highp float;

uniform sampler2D uTexture;
uniform vec2 uInvTexSize;

in vec2 vUv;
out vec4 fragColor;

void main() {
  vec3 rgbNW = texture(uTexture, vUv + vec2(-1.0, -1.0) * uInvTexSize).rgb;
  vec3 rgbNE = texture(uTexture, vUv + vec2( 1.0, -1.0) * uInvTexSize).rgb;
  vec3 rgbSW = texture(uTexture, vUv + vec2(-1.0,  1.0) * uInvTexSize).rgb;
  vec3 rgbSE = texture(uTexture, vUv + vec2( 1.0,  1.0) * uInvTexSize).rgb;
  vec3 rgbM  = texture(uTexture, vUv).rgb;

  vec3 luma_coeff = vec3(0.299, 0.587, 0.114);
  float lumaNW = dot(rgbNW, luma_coeff);
  float lumaNE = dot(rgbNE, luma_coeff);
  float lumaSW = dot(rgbSW, luma_coeff);
  float lumaSE = dot(rgbSE, luma_coeff);
  float lumaM  = dot(rgbM, luma_coeff);

  float lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
  float lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));

  vec2 dir;
  dir.x = -((lumaNW + lumaNE) - (lumaSW + lumaSE));
  dir.y =  ((lumaNW + lumaSW) - (lumaNE + lumaSE));

  const float FXAA_REDUCE_MIN = 1.0 / 128.0;
  const float FXAA_REDUCE_MUL = 1.0 / 8.0;
  const float FXAA_SPAN_MAX = 8.0;

  float dirReduce = max((lumaNW + lumaNE + lumaSW + lumaSE) * (0.25 * FXAA_REDUCE_MUL), FXAA_REDUCE_MIN);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = min(vec2(FXAA_SPAN_MAX), max(vec2(-FXAA_SPAN_MAX), dir * rcpDirMin)) * uInvTexSize;

  vec3 rgbA = 0.5 * (
    texture(uTexture, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
    texture(uTexture, vUv + dir * (2.0 / 3.0 - 0.5)).rgb
  );
  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture(uTexture, vUv + dir * -0.5).rgb +
    texture(uTexture, vUv + dir *  0.5).rgb
  );

  float lumaB = dot(rgbB, luma_coeff);
  fragColor = (lumaB < lumaMin || lumaB > lumaMax) ? vec4(rgbA, 1.0) : vec4(rgbB, 1.0);
}
`;

const _invProj = new THREE.Matrix4();
const _worldUp = new THREE.Vector3(0, 0, 1);
const _upView = new THREE.Vector3();
const _viewRot = new THREE.Matrix3();

export class OrcaPostPipeline {
  private sceneRT: THREE.WebGLRenderTarget;
  private ssaoRT: THREE.WebGLRenderTarget;
  private quadGeo: THREE.BufferGeometry;
  private quadCam: THREE.OrthographicCamera;
  private ssaoMat: THREE.RawShaderMaterial;
  private fxaaMat: THREE.RawShaderMaterial;
  private ssaoScene: THREE.Scene;
  private fxaaScene: THREE.Scene;
  private width = 1;
  private height = 1;

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));

    const depthTex = new THREE.DepthTexture(this.width, this.height);
    depthTex.type = THREE.FloatType;
    depthTex.format = THREE.DepthFormat;

    this.sceneRT = new THREE.WebGLRenderTarget(this.width, this.height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthTexture: depthTex,
      depthBuffer: true,
      stencilBuffer: false,
    });

    this.ssaoRT = new THREE.WebGLRenderTarget(this.width, this.height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });

    this.quadGeo = new THREE.BufferGeometry();
    this.quadGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
    );
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.ssaoMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VS,
      fragmentShader: ORCA_SSAO_FS,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uColorTex: { value: this.sceneRT.texture },
        uDepthTex: { value: depthTex },
        uInvTexSize: { value: new THREE.Vector2(1 / this.width, 1 / this.height) },
        uZFar: { value: 4000 },
        uInvProjection: { value: new THREE.Matrix4() },
        uUpView: { value: new THREE.Vector3(0, 1, 0) },
        uEnableSSAO: { value: 1 },
      },
    });

    this.fxaaMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VS,
      fragmentShader: ORCA_FXAA_FS,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTexture: { value: this.ssaoRT.texture },
        uInvTexSize: { value: new THREE.Vector2(1 / this.width, 1 / this.height) },
      },
    });

    this.ssaoScene = new THREE.Scene();
    this.ssaoScene.add(new THREE.Mesh(this.quadGeo, this.ssaoMat));
    this.fxaaScene = new THREE.Scene();
    this.fxaaScene.add(new THREE.Mesh(this.quadGeo, this.fxaaMat));
  }

  setSize(pixelWidth: number, pixelHeight: number) {
    const w = Math.max(1, Math.round(pixelWidth));
    const h = Math.max(1, Math.round(pixelHeight));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.sceneRT.setSize(w, h);
    this.ssaoRT.setSize(w, h);
    this.ssaoMat.uniforms.uInvTexSize.value.set(1 / w, 1 / h);
    this.fxaaMat.uniforms.uInvTexSize.value.set(1 / w, 1 / h);
  }

  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    ssaoEnabled: boolean
  ) {
    if (!ssaoEnabled) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }

    // Pass 1: Render scene + depth texture
    renderer.setRenderTarget(this.sceneRT);
    renderer.clear();
    renderer.render(scene, camera);

    // Pass 2: OrcaSlicer 12-tap slope-based SSAO
    _invProj.copy(camera.projectionMatrix).invert();
    _viewRot.setFromMatrix4(camera.matrixWorldInverse);
    _upView.copy(_worldUp).applyMatrix3(_viewRot).normalize();

    this.ssaoMat.uniforms.uZFar.value = camera.far;
    this.ssaoMat.uniforms.uInvProjection.value.copy(_invProj);
    this.ssaoMat.uniforms.uUpView.value.copy(_upView);
    this.ssaoMat.uniforms.uEnableSSAO.value = 1;

    renderer.setRenderTarget(this.ssaoRT);
    renderer.render(this.ssaoScene, this.quadCam);

    // Pass 3: OrcaSlicer FXAA to screen
    renderer.setRenderTarget(null);
    renderer.render(this.fxaaScene, this.quadCam);
  }

  dispose() {
    this.sceneRT.depthTexture?.dispose();
    this.sceneRT.dispose();
    this.ssaoRT.dispose();
    this.quadGeo.dispose();
    this.ssaoMat.dispose();
    this.fxaaMat.dispose();
  }
}
