/**
 * Direct WebGL2 (#version 300 es) port of OrcaSlicer 2.5.0's libvgcode
 * volumetric G-code renderer (SegmentTemplate.cpp, ViewerImpl.cpp, ShadersES.hpp).
 *
 * Renders every extruded G-code move as an instanced 8-vertex, 8-triangle
 * camera-aligned diamond/capsule volumetric bead with mitered joints,
 * joint bisector clipping, realistic glossy filament highlights, instant
 * layer dimming, and ray-cast section cut planes.
 */
import * as THREE from "three";
import type { FilamentSlot, GcodeFeatureType, ParsedGcode, PreviewColorScheme } from "../types";
import { FEATURE_COLORS, INDEX_TO_FEATURE, sampleHeatmapRGB } from "./gcode";

export const VGCODE_TEX_WIDTH = 2048;

const TRAVEL_RADIUS_MM = 0.09;

function hexToRgb255(hex: string): [number, number, number] {
  const clean = hex.replace("#", "").trim();
  if (clean.length === 6) {
    const n = parseInt(clean, 16);
    if (Number.isFinite(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const c = new THREE.Color(hex || "#94a3b8");
  const out = { r: 0, g: 0, b: 0 };
  c.getRGB(out, THREE.SRGBColorSpace);
  return [Math.round(out.r * 255), Math.round(out.g * 255), Math.round(out.b * 255)];
}

// Exact SegmentTemplate vertex & index arrays from OrcaSlicer src/libvgcode/src/SegmentTemplate.cpp
//     /1-------6\
//    / |       | \
//   2--0-------5--7
//    \ |       | /
//      3-------4
const SEGMENT_VERTEX_IDS = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]);
const SEGMENT_INDICES = new Uint16Array([
  0, 1, 2, // front spike
  0, 2, 3, // front spike
  0, 3, 4, // right/bottom body
  0, 4, 5, // right/bottom body
  0, 5, 6, // left/top body
  0, 6, 1, // left/top body
  5, 4, 7, // back spike
  5, 7, 6, // back spike
]);

// Direct port of OrcaSlicer Segments_Vertex_Shader_ES (src/libvgcode/src/ShadersES.hpp)
// Three.js RawShaderMaterial with glslVersion: THREE.GLSL3 prepends `#version 300 es`.
const SEGMENTS_VERTEX_SHADER = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;

#define POINTY_CAPS
#define FIX_TWISTING

uniform vec3 light_top_dir;
uniform float gloss_strength;
const float light_top_diffuse = 0.6 * 0.82;
const float light_top_specular = 0.6 * 0.28;
const float light_top_shininess = 20.0;
const vec3  light_front_dir = vec3(0.6985074, 0.1397015, 0.6985074);
const float light_front_diffuse = 0.6 * 0.42;
const float ambient = 0.37;
const float emission = 0.16;
const float REFERENCE_THICKNESS = 0.4;
const vec3 UP = vec3(0.0, 0.0, 1.0);

uniform mat4 view_matrix;
uniform mat4 projection_matrix;
uniform vec3 camera_position;
uniform sampler2D position_tex;
uniform sampler2D height_width_angle_tex;
uniform sampler2D color_tex;
uniform usampler2D segment_index_tex;
uniform bool reverse_order;
uniform int instances_count;
uniform int first_instance;
uniform vec4 clipping_plane;
uniform ivec2 lit_layers;
uniform int grey_below_layer;
uniform float dim_brightness;
uniform int kept_vertex;

in float vertex_id_float;

out vec3 color;
out vec3 color_direct;
out vec3 world_position;
out vec3 shadow_normal;
flat out int segment_id;
out vec3 cut_color_direct;
flat out float alpha;

vec3 decode_color(vec3 col, int id, int layer) {
  vec3 rgb = floor(255.0 * col + 0.5);
  if (id != kept_vertex && layer != lit_layers.x && layer != lit_layers.y) {
    if (dim_brightness >= 0.0)
      rgb = floor(rgb * dim_brightness);
    else if (layer < grey_below_layer)
      rgb = vec3(64.0);
  }
  return (1.0 / 255.0) * rgb;
}

float direct_lighting(vec3 eye_position, vec3 eye_normal) {
  float top_diffuse = light_top_diffuse * max(dot(eye_normal, light_top_dir), 0.0);
  float front_diffuse = light_front_diffuse * max(dot(eye_normal, light_front_dir), 0.0);
  float top_specular = light_top_specular * pow(max(dot(-normalize(eye_position), reflect(-light_top_dir, eye_normal)), 0.0), light_top_shininess);
  return top_diffuse + front_diffuse + top_specular;
}

float diffuse_lighting(vec3 eye_normal) {
  return light_top_diffuse * max(dot(eye_normal, light_top_dir), 0.0)
       + light_front_diffuse * max(dot(eye_normal, light_front_dir), 0.0);
}

ivec2 tex_coord(sampler2D sampler, int id) {
  ivec2 tex_size = textureSize(sampler, 0);
  return (tex_size.y == 1) ? ivec2(id, 0) : ivec2(id % tex_size.x, id / tex_size.x);
}

ivec2 tex_coord_u(usampler2D sampler, int id) {
  ivec2 tex_size = textureSize(sampler, 0);
  return (tex_size.y == 1) ? ivec2(id, 0) : ivec2(id % tex_size.x, id / tex_size.x);
}

void main() {
  int vertex_id = int(vertex_id_float);
  int instance = first_instance + (reverse_order ? instances_count - 1 - gl_InstanceID : gl_InstanceID);
  int id_a = int(texelFetch(segment_index_tex, tex_coord_u(segment_index_tex, instance), 0).r);
  alpha = texelFetch(color_tex, tex_coord(color_tex, id_a), 0).a;
  int id_b = id_a + 1;
  vec4 pos_a_full = texelFetch(position_tex, tex_coord(position_tex, id_a), 0);
  vec4 pos_b_full = texelFetch(position_tex, tex_coord(position_tex, id_b), 0);
  vec3 pos_a = pos_a_full.xyz;
  vec3 pos_b = pos_b_full.xyz;
  vec3 line = pos_b - pos_a;

  float line_len = length(line);
  vec3 line_dir = line_len < 1e-4 ? vec3(1.0, 0.0, 0.0) : line / line_len;
  vec3 line_right_dir;
  if (abs(dot(line_dir, UP)) > 0.9) {
    line_right_dir = normalize(cross(vec3(1.0, 0.0, 0.0), line_dir));
  } else {
    line_right_dir = normalize(cross(line_dir, UP));
  }
  vec3 line_up_dir = normalize(cross(line_right_dir, line_dir));

  vec3 joint_prev = vec3(0.0);
  vec3 joint_next = vec3(0.0);
  int pos_tex_cap = textureSize(position_tex, 0).x * textureSize(position_tex, 0).y;
  if (alpha < 1.0 || gloss_strength > 0.0) {
    if (id_a > 0 && fract(pos_a_full.w) > 0.25) {
      vec3 prev = pos_a - texelFetch(position_tex, tex_coord(position_tex, id_a - 1), 0).xyz;
      if (dot(prev, prev) < 1e-4 && id_a > 1)
        prev = pos_a - texelFetch(position_tex, tex_coord(position_tex, id_a - 2), 0).xyz;
      vec3 n = dot(prev, prev) > 1e-8 ? normalize(prev) + line_dir : vec3(0.0);
      if (dot(n, n) > 1e-4)
        joint_prev = prev;
    }
    if (id_b + 1 < pos_tex_cap && fract(pos_b_full.w) > 0.25) {
      vec3 next = texelFetch(position_tex, tex_coord(position_tex, id_b + 1), 0).xyz - pos_b;
      if (dot(next, next) < 1e-4 && id_b + 2 < pos_tex_cap)
        next = texelFetch(position_tex, tex_coord(position_tex, id_b + 2), 0).xyz - pos_b;
      vec3 n = dot(next, next) > 1e-8 ? line_dir + normalize(next) : vec3(0.0);
      if (dot(n, n) > 1e-4)
        joint_next = next;
    }
  }

  const vec2 horizontal_vertical_view_signs_array[16] = vec2[](
    // horizontal view (from right)
    vec2(1.0, 0.0),
    vec2(0.0, 1.0),
    vec2(0.0, 0.0),
    vec2(0.0, -1.0),
    vec2(0.0, -1.0),
    vec2(1.0, 0.0),
    vec2(0.0, 1.0),
    vec2(0.0, 0.0),
    // vertical view (from top)
    vec2(0.0, 1.0),
    vec2(-1.0, 0.0),
    vec2(0.0, 0.0),
    vec2(1.0, 0.0),
    vec2(1.0, 0.0),
    vec2(0.0, 1.0),
    vec2(-1.0, 0.0),
    vec2(0.0, 0.0)
  );

  int id = vertex_id < 4 ? id_a : id_b;
  vec3 endpoint_pos = vertex_id < 4 ? pos_a : pos_b;
  vec3 height_width_angle = texelFetch(height_width_angle_tex, tex_coord(height_width_angle_tex, id), 0).xyz;
  vec3 joint_other = vertex_id < 4 ? joint_prev : joint_next;
  if (height_width_angle.z == 0.0 && dot(joint_other, joint_other) > 0.0) {
    vec3 into = vertex_id < 4 ? joint_other : line;
    vec3 onto = vertex_id < 4 ? line : joint_other;
    height_width_angle.z = atan(into.x * onto.y - into.y * onto.x, dot(into, onto));
  }

#ifdef FIX_TWISTING
  int closer_id = (dot(camera_position - pos_a, camera_position - pos_a) < dot(camera_position - pos_b, camera_position - pos_b)) ? id_a : id_b;
  vec3 closer_pos = (closer_id == id_a) ? pos_a : pos_b;
  vec3 camera_view_dir = normalize(closer_pos - camera_position);
  vec3 closer_height_width_angle = texelFetch(height_width_angle_tex, tex_coord(height_width_angle_tex, closer_id), 0).xyz;
  vec3 diagonal_dir_border = normalize(closer_height_width_angle.x * line_up_dir + closer_height_width_angle.y * line_right_dir);
#else
  vec3 camera_view_dir = normalize(endpoint_pos - camera_position);
  vec3 diagonal_dir_border = normalize(height_width_angle.x * line_up_dir + height_width_angle.y * line_right_dir);
#endif

  if (alpha < 1.0) {
    vec2 hw = texelFetch(height_width_angle_tex, tex_coord(height_width_angle_tex, id_a), 0).xy;
    float path = 1.0 / max(abs(dot(camera_view_dir, line_up_dir)) / hw.x + abs(dot(camera_view_dir, line_right_dir)) / hw.y, 1e-3);
    alpha = min(1.0 - pow(1.0 - alpha, min(path / REFERENCE_THICKNESS, 16.0)), 0.999);
  }

  bool is_vertical_view = abs(dot(camera_view_dir, line_up_dir)) / max(abs(dot(diagonal_dir_border, line_up_dir)), 1e-5) >
    abs(dot(camera_view_dir, line_right_dir)) / max(abs(dot(diagonal_dir_border, line_right_dir)), 1e-5);
  vec2 signs = horizontal_vertical_view_signs_array[vertex_id + 8 * int(is_vertical_view)];

  float view_right_sign = sign(dot(-camera_view_dir, line_right_dir));
  if (view_right_sign == 0.0) view_right_sign = 1.0;
  float view_top_sign = sign(dot(-camera_view_dir, line_up_dir));
  if (view_top_sign == 0.0) view_top_sign = 1.0;

  float half_height = 0.5 * height_width_angle.x;
  float half_width = 0.5 * height_width_angle.y;
  vec3 horizontal_dir = half_width * line_right_dir;
  vec3 vertical_dir = half_height * line_up_dir;
  float horizontal_sign = signs.x * view_right_sign;
  float vertical_sign = signs.y * view_top_sign;
  vec3 pos = endpoint_pos + horizontal_sign * horizontal_dir + vertical_sign * vertical_dir;

  if (vertex_id == 2 || vertex_id == 7) {
    float line_dir_sign = (vertex_id == 2) ? -1.0 : 1.0;
    if (height_width_angle.z == 0.0) {
#ifdef POINTY_CAPS
      pos += line_dir_sign * line_dir * half_width;
#endif
    } else {
      pos += line_dir_sign * line_dir * half_width * sin(abs(height_width_angle.z) * 0.5);
      pos += sign(height_width_angle.z) * horizontal_dir * cos(abs(height_width_angle.z) * 0.5);
    }
  }

  vec3 eye_position = (view_matrix * vec4(pos, 1.0)).xyz;
  vec3 normal_delta = pos - endpoint_pos;
  vec3 world_normal = dot(normal_delta, normal_delta) > 1e-10 ? normalize(normal_delta) : UP;
  vec3 eye_normal = (view_matrix * vec4(world_normal, 0.0)).xyz;

  int layer_id = int(vertex_id < 4 ? pos_a_full.w : pos_b_full.w);
  vec3 color_base = decode_color(texelFetch(color_tex, tex_coord(color_tex, id), 0).rgb, id, layer_id);
  color = color_base * (ambient + emission);
  color_direct = color_base * ((alpha < 1.0 || gloss_strength > 0.0) ? diffuse_lighting(eye_normal) : direct_lighting(eye_position, eye_normal));
  world_position = pos;
  shadow_normal = eye_normal;
  segment_id = id_a;
  cut_color_direct = clipping_plane.xyz == vec3(0.0) ? vec3(0.0) :
    color_base * ((alpha < 1.0 || gloss_strength > 0.0) ? diffuse_lighting(mat3(view_matrix) * -clipping_plane.xyz) :
                                direct_lighting(eye_position, mat3(view_matrix) * -clipping_plane.xyz));
  gl_Position = projection_matrix * vec4(eye_position, 1.0);
}
`;

// Direct port of OrcaSlicer Segments_Fragment_Shader_ES (src/libvgcode/src/ShadersES.hpp)
const SEGMENTS_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform vec3 light_top_dir;
uniform sampler2D shadow_map;
uniform mat4 shadow_light_vp;
uniform float shadow_intensity;
uniform float shadow_map_texel;
uniform float exposure;
uniform float saturation;
uniform vec4 clipping_plane;
uniform mat4 view_matrix;
uniform mat4 projection_matrix;
uniform vec3 camera_position;
uniform sampler2D position_tex;
uniform sampler2D height_width_angle_tex;
uniform float gloss_strength;

const vec3 UP = vec3(0.0, 0.0, 1.0);
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const float GLOSS_SHININESS = 80.0;

in vec3 color;
in vec3 color_direct;
in vec3 world_position;
in vec3 shadow_normal;
flat in int segment_id;
in vec3 cut_color_direct;
flat in float alpha;

out vec4 fragment_color;

float shadow_shade(vec3 position, vec3 normal) {
  if (shadow_intensity <= 0.0)
    return 1.0;
  vec4 lp = shadow_light_vp * vec4(position, 1.0);
  vec3 proj = lp.xyz / lp.w;
  proj = proj * 0.5 + 0.5;
  if (proj.z > 1.0)
    return 1.0;
  float NdotL = dot(normalize(normal), light_top_dir);
  float bias = mix(0.0004, 0.004, clamp(1.0 - NdotL, 0.0, 1.0));
  float sum = 0.0;
  for (int x = -2; x <= 2; ++x) {
    for (int y = -2; y <= 2; ++y) {
      float closest = texture(shadow_map, proj.xy + vec2(float(x), float(y)) * shadow_map_texel).r;
      sum += (proj.z - bias > closest) ? 1.0 : 0.0;
    }
  }
  return 1.0 - shadow_intensity * (sum / 25.0);
}

vec4 fetch_tex(sampler2D sampler, int id) {
  ivec2 tex_size = textureSize(sampler, 0);
  return texelFetch(sampler, (tex_size.y == 1) ? ivec2(id, 0) : ivec2(id % tex_size.x, id / tex_size.x), 0);
}

bool find_cut(out vec3 cut) {
  vec3 ray = projection_matrix[3][3] == 1.0 ? -vec3(view_matrix[0][2], view_matrix[1][2], view_matrix[2][2]) :
                                             normalize(world_position - camera_position);
  float approach = dot(clipping_plane.xyz, ray);
  if (approach <= 0.0)
    return false;
  cut = world_position - dot(vec4(world_position, 1.0), clipping_plane) / approach * ray;
  vec3 pos_a = fetch_tex(position_tex, segment_id).xyz;
  vec3 line = fetch_tex(position_tex, segment_id + 1).xyz - pos_a;
  float length_sq = dot(line, line);
  float along = length_sq < 1e-8 ? -1.0 : dot(cut - pos_a, line) / length_sq;
  if (along < 0.0 || along > 1.0)
    return false;
  vec3 line_dir = line * inversesqrt(length_sq);
  vec3 right_dir = abs(dot(line_dir, UP)) > 0.9 ? normalize(cross(vec3(1.0, 0.0, 0.0), line_dir)) : normalize(cross(line_dir, UP));
  vec3 offset = cut - pos_a - along * line;
  vec2 half_height_width = 0.5 * mix(fetch_tex(height_width_angle_tex, segment_id).xy,
                                     fetch_tex(height_width_angle_tex, segment_id + 1).xy, along);
  return abs(dot(offset, right_dir)) / max(half_height_width.y, 1e-4)
       + abs(dot(offset, cross(right_dir, line_dir))) / max(half_height_width.x, 1e-4) <= 1.0;
}

bool beyond_joint(int id, vec3 pos, vec3 line_dir, int step) {
  int size = textureSize(position_tex, 0).x * textureSize(position_tex, 0).y;
  if (id + step < 0 || id + step >= size || fract(fetch_tex(position_tex, id).w) <= 0.25)
    return false;
  vec3 dir = float(step) * (fetch_tex(position_tex, id + step).xyz - pos);
  if (dot(dir, dir) < 1e-4 && id + 2 * step >= 0 && id + 2 * step < size)
    dir = float(step) * (fetch_tex(position_tex, id + 2 * step).xyz - pos);
  vec3 n = dot(dir, dir) > 1e-8 ? normalize(dir) + line_dir : vec3(0.0);
  return dot(n, n) > 1e-4 && float(step) * dot(normalize(n), world_position - pos) > 0.02;
}

void main() {
  if (alpha < 1.0 || gloss_strength > 0.0) {
    vec3 pos_a = fetch_tex(position_tex, segment_id).xyz;
    vec3 pos_b = fetch_tex(position_tex, segment_id + 1).xyz;
    vec3 seg = pos_b - pos_a;
    if (dot(seg, seg) > 1e-8) {
      vec3 line_dir = normalize(seg);
      if (beyond_joint(segment_id, pos_a, line_dir, -1) || beyond_joint(segment_id + 1, pos_b, line_dir, 1))
        discard;
    }
  }
  vec3 c;
  vec3 position = world_position;
  vec3 normal = shadow_normal;
  bool cut_face = false;
  float shade;
  if (dot(vec4(world_position, 1.0), clipping_plane) >= 0.0) {
    shade = shadow_shade(position, normal);
    c = color + color_direct * shade;
  } else {
    if (!find_cut(position))
      discard;
    cut_face = true;
    normal = mat3(view_matrix) * -clipping_plane.xyz;
    shade = shadow_shade(position, normal);
    c = color + cut_color_direct * shade;
  }
  c *= exposure;
  c = mix(vec3(dot(c, LUMA)), c, saturation);

  float gloss = 0.0;
  if (gloss_strength > 0.0) {
    vec3 across = normalize(normal);
    vec3 start = fetch_tex(position_tex, segment_id).xyz;
    vec3 line = fetch_tex(position_tex, segment_id + 1).xyz - start;
    float length_sq = dot(line, line);
    if (!cut_face && length_sq > 1e-8) {
      float t = clamp(dot(position - start, line) / length_sq, 0.0, 1.0);
      vec2 half_height_width = 0.5 * mix(fetch_tex(height_width_angle_tex, segment_id).xy,
                                         fetch_tex(height_width_angle_tex, segment_id + 1).xy, t);
      vec3 radial = position - start - t * line;
      vec3 n = vec3(
        radial.xy / max(half_height_width.y * half_height_width.y, 1e-6),
        radial.z / max(half_height_width.x * half_height_width.x, 1e-6)
      );
      n = dot(n, n) > 1e-12 ? normalize(n) : UP;
      across = mat3(view_matrix) * (n - dot(n, line) / length_sq * line);
    }
    vec3 v = projection_matrix[3][3] == 1.0 ? vec3(0.0, 0.0, 1.0) : -normalize((view_matrix * vec4(position, 1.0)).xyz);
    gloss = dot(across, across) > 1e-8
      ? gloss_strength * dot(across, across) * pow(max(dot(v, reflect(-light_top_dir, normalize(across))), 0.0), GLOSS_SHININESS) * shade
      : 0.0;
  }

  if (alpha == 1.0) {
    fragment_color = vec4(clamp(c + gloss, 0.0, 1.0), 1.0);
    return;
  }
  fragment_color = vec4(clamp(c, 0.0, 1.0) * alpha + gloss, alpha);
}
`;

export interface VGCodeVertexStream {
  vertexCount: number;
  texWidth: number;
  texHeight: number;
  positions: Float32Array;       // texWidth * texHeight * 4 (RGBA32F)
  heightsWidthsAngles: Float32Array; // texWidth * texHeight * 4 (RGBA32F)
  segmentVertexStart: Uint32Array;   // length = gcode.segmentCount, maps seg -> vertex id_a
  vertexToSegment: Int32Array;       // length = vertexCount, maps vertex -> owning seg for color lookup
  segmentIsTravel: Uint8Array;       // length = gcode.segmentCount (1 = travel, 0 = extrude)
}

/**
 * Converts parsed G-code segments into OrcaSlicer libvgcode's connected PathVertex stream:
 * - Consecutive segments of the same move kind & feature share vertices so mitered joints form smoothly.
 * - Feature splits at the same XYZ position repeat the vertex in-place (preserving joint bisectors).
 * - Extrusion Z is shifted down by 0.5 * layerHeight (matching ViewerImpl.cpp:1086).
 * - position.w encodes floor(layerId) + (isJoint ? 0.5 : 0.0).
 * - height_width_angle.z stores atan2(prev × curr, prev · curr) miter angle.
 */
export function buildVGCodeVertexStream(gcode: ParsedGcode): VGCodeVertexStream {
  const segCount = gcode.segmentCount;
  const travelIdx = INDEX_TO_FEATURE.indexOf("Travel");
  const segmentVertexStart = new Uint32Array(segCount);
  const segmentIsTravel = new Uint8Array(segCount);

  if (segCount === 0) {
    return {
      vertexCount: 0,
      texWidth: 1,
      texHeight: 1,
      positions: new Float32Array(4),
      heightsWidthsAngles: new Float32Array(4),
      segmentVertexStart,
      vertexToSegment: new Int32Array(0),
      segmentIsTravel,
    };
  }

  // Worst case 2 vertices per segment; pre-allocate and trim to exact texture size
  const maxVerts = segCount * 2;
  const vx = new Float32Array(maxVerts);
  const vy = new Float32Array(maxVerts);
  const vz = new Float32Array(maxVerts);
  const vLayer = new Uint16Array(maxVerts);
  const vIsTravel = new Uint8Array(maxVerts);
  const vHeight = new Float32Array(maxVerts);
  const vWidth = new Float32Array(maxVerts);
  const vSegOwner = new Int32Array(maxVerts);
  const vLineValid = new Uint8Array(maxVerts); // 1 if vertex i -> i+1 is a real drawn segment

  let vCount = 0;

  const samePt = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) =>
    Math.abs(ax - bx) < 1e-4 && Math.abs(ay - by) < 1e-4 && Math.abs(az - bz) < 1e-4;

  let prevEndX = NaN, prevEndY = NaN, prevEndZ = NaN;
  let prevTravel = 255;
  let prevFeat = 255;
  let prevLayer = 65535;
  let prevHeight = 0;
  let prevWidth = 0;

  for (let i = 0; i < segCount; i++) {
    const i3 = i * 3;
    const sx = gcode.starts[i3];
    const sy = gcode.starts[i3 + 1];
    const sz = gcode.starts[i3 + 2];
    const ex = gcode.ends[i3];
    const ey = gcode.ends[i3 + 1];
    const ez = gcode.ends[i3 + 2];
    const feat = gcode.features[i];
    const isTrv = feat === travelIdx ? 1 : 0;
    segmentIsTravel[i] = isTrv;
    const layer = gcode.layersArr[i];
    const lh = isTrv ? TRAVEL_RADIUS_MM : Math.max(0.05, gcode.layerHeights[i] || 0.2);
    const lw = isTrv ? TRAVEL_RADIUS_MM : Math.max(0.15, gcode.lineWidths[i] || 0.42);

    const canChain =
      vCount > 0 &&
      isTrv === prevTravel &&
      feat === prevFeat &&
      layer === prevLayer &&
      Math.abs(lh - prevHeight) < 1e-4 &&
      Math.abs(lw - prevWidth) < 1e-4 &&
      samePt(prevEndX, prevEndY, prevEndZ, sx, sy, sz);

    let idA: number;
    if (canChain) {
      idA = vCount - 1;
    } else {
      idA = vCount++;
      vx[idA] = sx;
      vy[idA] = sy;
      vz[idA] = sz;
      vLayer[idA] = layer;
      vIsTravel[idA] = isTrv;
      vHeight[idA] = lh;
      vWidth[idA] = lw;
      vSegOwner[idA] = i;
    }

    const idB = vCount++;
    vx[idB] = ex;
    vy[idB] = ey;
    vz[idB] = ez;
    vLayer[idB] = layer;
    vIsTravel[idB] = isTrv;
    vHeight[idB] = lh;
    vWidth[idB] = lw;
    vSegOwner[idB] = i;

    vLineValid[idA] = 1;
    segmentVertexStart[i] = idA;

    prevEndX = ex; prevEndY = ey; prevEndZ = ez;
    prevTravel = isTrv;
    prevFeat = feat;
    prevLayer = layer;
    prevHeight = lh;
    prevWidth = lw;
  }

  const texWidth = vCount < VGCODE_TEX_WIDTH ? Math.max(1, vCount) : VGCODE_TEX_WIDTH;
  const texHeight = Math.max(1, Math.ceil(vCount / texWidth));
  const texCap = texWidth * texHeight;

  const positions = new Float32Array(texCap * 4);
  const heightsWidthsAngles = new Float32Array(texCap * 4);

  const repeated = (j: number): boolean =>
    j >= 0 &&
    j + 1 < vCount &&
    vIsTravel[j] === vIsTravel[j + 1] &&
    samePt(vx[j], vy[j], vz[j], vx[j + 1], vy[j + 1], vz[j + 1]);

  for (let i = 0; i < vCount; i++) {
    const prevValid = i > 0 && vLineValid[i - 1] === 1;
    const thisValid = vLineValid[i] === 1 && i + 1 < vCount;

    const beforeJoint =
      i > 0 && (vLineValid[i - 1] === 1 || (i > 1 && repeated(i - 1) && vLineValid[i - 2] === 1));
    const afterJoint =
      thisValid || (repeated(i) && i + 1 < vCount && vLineValid[i + 1] === 1);
    const isJoint = beforeJoint && afterJoint;

    const o4 = i * 4;
    const zAdj = vIsTravel[i] ? vz[i] : vz[i] - 0.5 * vHeight[i];
    positions[o4] = vx[i];
    positions[o4 + 1] = vy[i];
    positions[o4 + 2] = zAdj;
    positions[o4 + 3] = vLayer[i] + (isJoint ? 0.5 : 0.0);

    let angle = 0;
    if (prevValid && thisValid) {
      const pDx = vx[i] - vx[i - 1];
      const pDy = vy[i] - vy[i - 1];
      const pDz = vz[i] - vz[i - 1];
      const cDx = vx[i + 1] - vx[i];
      const cDy = vy[i + 1] - vy[i];
      const cDz = vz[i + 1] - vz[i];
      const crossZ = pDx * cDy - pDy * cDx;
      const dotVal = pDx * cDx + pDy * cDy + pDz * cDz;
      angle = Math.atan2(crossZ, dotVal);
    }

    heightsWidthsAngles[o4] = vHeight[i];
    heightsWidthsAngles[o4 + 1] = vWidth[i];
    heightsWidthsAngles[o4 + 2] = angle;
    heightsWidthsAngles[o4 + 3] = 0;
  }

  return {
    vertexCount: vCount,
    texWidth,
    texHeight,
    positions,
    heightsWidthsAngles,
    segmentVertexStart,
    vertexToSegment: vSegOwner.subarray(0, vCount),
    segmentIsTravel,
  };
}

export interface VGCodeVisualOptions {
  layerBottom: number;
  layerTop: number;
  moveIndex: number;
  hiddenFeatures: Set<GcodeFeatureType>;
  colorScheme: PreviewColorScheme;
  filaments: FilamentSlot[];
  realisticGloss: boolean;
  dimLowerLayers: boolean;
  sectionCutEnabled: boolean;
  sectionCutAxis: "x" | "y" | "z";
  sectionCutPosition: number;
}

/**
 * Self-contained Three.js WebGL2 volumetric G-code viewer backed by OrcaSlicer's libvgcode shaders.
 * Caches GPU position/geometry textures per ParsedGcode; scrubbing layers, moves, color schemes,
 * gloss, or section cut updates only lightweight textures/uniforms with zero geometry rebuilds.
 */
export class VGCodeRenderer {
  public readonly group: THREE.Group;
  private gcode: ParsedGcode;
  private stream: VGCodeVertexStream;

  private positionTex: THREE.DataTexture;
  private hwaTex: THREE.DataTexture;
  private colorTex: THREE.DataTexture;
  private colorBytes: Uint8Array;
  private shadowDummyTex: THREE.DataTexture;

  private indexTex: THREE.DataTexture;
  private indexData: Uint32Array;
  private indexTexWidth: number;
  private indexTexHeight: number;

  private opaqueGeom: THREE.InstancedBufferGeometry;
  private travelGeom: THREE.InstancedBufferGeometry;
  private opaqueMat: THREE.RawShaderMaterial;
  private travelMat: THREE.RawShaderMaterial;
  private opaqueMesh: THREE.Mesh;
  private travelMesh: THREE.Mesh;

  private opaqueCount = 0;
  private travelCount = 0;
  private lastColorKey = "";

  constructor(gcode: ParsedGcode) {
    this.gcode = gcode;
    this.group = new THREE.Group();
    this.stream = buildVGCodeVertexStream(gcode);

    const { texWidth, texHeight, positions, heightsWidthsAngles } = this.stream;

    this.positionTex = new THREE.DataTexture(positions, texWidth, texHeight, THREE.RGBAFormat, THREE.FloatType);
    this.positionTex.internalFormat = "RGBA32F";
    this.positionTex.minFilter = THREE.NearestFilter;
    this.positionTex.magFilter = THREE.NearestFilter;
    this.positionTex.generateMipmaps = false;
    this.positionTex.flipY = false;
    this.positionTex.needsUpdate = true;

    this.hwaTex = new THREE.DataTexture(heightsWidthsAngles, texWidth, texHeight, THREE.RGBAFormat, THREE.FloatType);
    this.hwaTex.internalFormat = "RGBA32F";
    this.hwaTex.minFilter = THREE.NearestFilter;
    this.hwaTex.magFilter = THREE.NearestFilter;
    this.hwaTex.generateMipmaps = false;
    this.hwaTex.flipY = false;
    this.hwaTex.needsUpdate = true;

    this.colorBytes = new Uint8Array(texWidth * texHeight * 4);
    this.colorTex = new THREE.DataTexture(this.colorBytes, texWidth, texHeight, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.colorTex.minFilter = THREE.NearestFilter;
    this.colorTex.magFilter = THREE.NearestFilter;
    this.colorTex.generateMipmaps = false;
    this.colorTex.flipY = false;
    this.colorTex.needsUpdate = true;

    // 1x1 dummy shadow texture so shadow_map sampler is always valid in WebGL2
    this.shadowDummyTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.shadowDummyTex.needsUpdate = true;

    // Segment index texture (opaque segments [0..opaqueCount), travel segments [opaqueCount..total))
    const segCap = Math.max(1, gcode.segmentCount);
    this.indexTexWidth = segCap < VGCODE_TEX_WIDTH ? segCap : VGCODE_TEX_WIDTH;
    this.indexTexHeight = Math.max(1, Math.ceil(segCap / this.indexTexWidth));
    this.indexData = new Uint32Array(this.indexTexWidth * this.indexTexHeight);
    this.indexTex = new THREE.DataTexture(
      this.indexData,
      this.indexTexWidth,
      this.indexTexHeight,
      THREE.RedIntegerFormat,
      THREE.UnsignedIntType
    );
    this.indexTex.internalFormat = "R32UI";
    this.indexTex.minFilter = THREE.NearestFilter;
    this.indexTex.magFilter = THREE.NearestFilter;
    this.indexTex.generateMipmaps = false;
    this.indexTex.flipY = false;
    this.indexTex.needsUpdate = true;

    const makeTemplateGeom = () => {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute("vertex_id_float", new THREE.BufferAttribute(SEGMENT_VERTEX_IDS, 1));
      g.setIndex(new THREE.BufferAttribute(SEGMENT_INDICES, 1));
      g.instanceCount = 0;
      return g;
    };

    const makeUniforms = () => ({
      view_matrix: { value: new THREE.Matrix4() },
      projection_matrix: { value: new THREE.Matrix4() },
      camera_position: { value: new THREE.Vector3() },
      position_tex: { value: this.positionTex },
      height_width_angle_tex: { value: this.hwaTex },
      color_tex: { value: this.colorTex },
      segment_index_tex: { value: this.indexTex },
      shadow_map: { value: this.shadowDummyTex },
      shadow_light_vp: { value: new THREE.Matrix4() },
      shadow_intensity: { value: 0.0 },
      shadow_map_texel: { value: 1.0 / 1024.0 },
      reverse_order: { value: false },
      instances_count: { value: 0 },
      first_instance: { value: 0 },
      clipping_plane: { value: new THREE.Vector4(0, 0, 0, 1) },
      light_top_dir: { value: new THREE.Vector3(-0.4574957, 0.4574957, 0.7624929) },
      gloss_strength: { value: 0.6 },
      exposure: { value: 1.04 },
      saturation: { value: 1.08 },
      lit_layers: { value: new THREE.Vector2(-1, -1) },
      grey_below_layer: { value: -1 },
      dim_brightness: { value: -1.0 },
      kept_vertex: { value: -1 },
    });

    this.opaqueGeom = makeTemplateGeom();
    this.opaqueMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SEGMENTS_VERTEX_SHADER,
      fragmentShader: SEGMENTS_FRAGMENT_SHADER,
      uniforms: makeUniforms(),
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
      transparent: false,
    });
    this.opaqueMesh = new THREE.Mesh(this.opaqueGeom, this.opaqueMat);
    this.opaqueMesh.frustumCulled = false;
    this.opaqueMesh.renderOrder = 1;
    this.opaqueMesh.onBeforeRender = (_renderer, _scene, camera) => {
      const u = this.opaqueMat.uniforms;
      u.view_matrix.value.copy(camera.matrixWorldInverse);
      u.projection_matrix.value.copy(camera.projectionMatrix);
      u.camera_position.value.copy(camera.position);
      u.reverse_order.value = camera.matrixWorldInverse.elements[10] > 0.0;
    };

    this.travelGeom = makeTemplateGeom();
    this.travelMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SEGMENTS_VERTEX_SHADER,
      fragmentShader: SEGMENTS_FRAGMENT_SHADER,
      uniforms: makeUniforms(),
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.travelMesh = new THREE.Mesh(this.travelGeom, this.travelMat);
    this.travelMesh.frustumCulled = false;
    this.travelMesh.renderOrder = 2;
    this.travelMesh.onBeforeRender = (_renderer, _scene, camera) => {
      const u = this.travelMat.uniforms;
      u.view_matrix.value.copy(camera.matrixWorldInverse);
      u.projection_matrix.value.copy(camera.projectionMatrix);
      u.camera_position.value.copy(camera.position);
      u.reverse_order.value = !(camera.matrixWorldInverse.elements[10] > 0.0);
    };

    this.group.add(this.opaqueMesh, this.travelMesh);
  }

  private updateColors(colorScheme: PreviewColorScheme, filaments: FilamentSlot[]) {
    const key = `${colorScheme}|${filaments.map((f) => f.color).join(",")}`;
    if (key === this.lastColorKey) return;
    this.lastColorKey = key;

    const g = this.gcode;
    const featureRgb = INDEX_TO_FEATURE.map((f) => hexToRgb255(FEATURE_COLORS[f] || "#94a3b8"));
    const filamentRgb = filaments.map((f) => hexToRgb255(f.color || "#22c55e"));
    if (filamentRgb.length === 0) filamentRgb.push([34, 197, 94]);

    const [minSpd, maxSpd] = g.ranges.speed;
    const [minFlw, maxFlw] = g.ranges.flow;
    const [minLH, maxLH] = g.ranges.layerHeight;
    const [minLW, maxLW] = g.ranges.lineWidth;
    const [minT, maxT] = g.ranges.temp;

    const vCount = this.stream.vertexCount;
    const vToSeg = this.stream.vertexToSegment;
    const isTravelArr = this.stream.segmentIsTravel;
    const bytes = this.colorBytes;

    for (let v = 0; v < vCount; v++) {
      const seg = vToSeg[v];
      const o4 = v * 4;
      if (isTravelArr[seg]) {
        bytes[o4] = 56;
        bytes[o4 + 1] = 189;
        bytes[o4 + 2] = 248;
        bytes[o4 + 3] = 155;
        continue;
      }

      let r = 200, gr = 200, b = 200;
      if (colorScheme === "line_type") {
        const rgb = featureRgb[g.features[seg]] || featureRgb[featureRgb.length - 1];
        r = rgb[0]; gr = rgb[1]; b = rgb[2];
      } else if (colorScheme === "filament") {
        const rgb = filamentRgb[g.filaments[seg]] || filamentRgb[0];
        r = rgb[0]; gr = rgb[1]; b = rgb[2];
      } else {
        let t = 0.5;
        if (colorScheme === "speed") t = (g.speeds[seg] - minSpd) / Math.max(1e-3, maxSpd - minSpd);
        else if (colorScheme === "flow") t = (g.flows[seg] - minFlw) / Math.max(1e-3, maxFlw - minFlw);
        else if (colorScheme === "layer_height") t = (g.layerHeights[seg] - minLH) / Math.max(1e-3, maxLH - minLH);
        else if (colorScheme === "line_width") t = (g.lineWidths[seg] - minLW) / Math.max(1e-3, maxLW - minLW);
        else if (colorScheme === "fan_speed") t = g.fanSpeeds[seg] / 100;
        else if (colorScheme === "temperature") t = (g.temps[seg] - minT) / Math.max(1e-3, maxT - minT);
        const [hr, hg, hb] = sampleHeatmapRGB(t);
        r = Math.round(hr * 255);
        gr = Math.round(hg * 255);
        b = Math.round(hb * 255);
      }

      bytes[o4] = r;
      bytes[o4 + 1] = gr;
      bytes[o4 + 2] = b;
      bytes[o4 + 3] = 255;
    }

    this.colorTex.needsUpdate = true;
  }

  public update(opts: VGCodeVisualOptions) {
    this.updateColors(opts.colorScheme, opts.filaments);

    const g = this.gcode;
    const maxSeg = Math.min(g.segmentCount, Math.max(0, opts.moveIndex));
    const hiddenMask = INDEX_TO_FEATURE.map((f) => opts.hiddenFeatures.has(f));
    const segStart = this.stream.segmentVertexStart;
    const isTravelArr = this.stream.segmentIsTravel;

    // Pack opaque extrusions first, translucent travel moves after (exact ViewerImpl.cpp layout)
    let oPtr = 0;
    for (let i = 0; i < maxSeg; i++) {
      if (isTravelArr[i]) continue;
      const l = g.layersArr[i];
      if (l < opts.layerBottom || l > opts.layerTop) continue;
      if (hiddenMask[g.features[i]]) continue;
      this.indexData[oPtr++] = segStart[i];
    }
    this.opaqueCount = oPtr;

    let tPtr = oPtr;
    if (!opts.hiddenFeatures.has("Travel")) {
      for (let i = 0; i < maxSeg; i++) {
        if (!isTravelArr[i]) continue;
        const l = g.layersArr[i];
        if (l < opts.layerBottom || l > opts.layerTop) continue;
        this.indexData[tPtr++] = segStart[i];
      }
    }
    this.travelCount = tPtr - oPtr;
    this.indexTex.needsUpdate = true;

    this.opaqueGeom.instanceCount = this.opaqueCount;
    this.opaqueMesh.visible = this.opaqueCount > 0;
    this.travelGeom.instanceCount = this.travelCount;
    this.travelMesh.visible = this.travelCount > 0;

    // Clipping plane: dot(vec4(world_position, 1.0), clipping_plane) >= 0 keeps fragment.
    // Orient Y to keep the back half (Y >= pos) so the glowing cut face points directly at the front camera.
    const clip = new THREE.Vector4(0, 0, 0, 1);
    if (opts.sectionCutEnabled) {
      if (opts.sectionCutAxis === "x") clip.set(-1, 0, 0, opts.sectionCutPosition);
      else if (opts.sectionCutAxis === "y") clip.set(0, 1, 0, -opts.sectionCutPosition);
      else clip.set(0, 0, -1, opts.sectionCutPosition);
    }

    const applyCommon = (mat: THREE.RawShaderMaterial, first: number, count: number, isTravel: boolean) => {
      const u = mat.uniforms;
      u.first_instance.value = first;
      u.instances_count.value = count;
      u.clipping_plane.value.copy(clip);
      u.gloss_strength.value = isTravel ? 0.0 : opts.realisticGloss ? 0.64 : 0.0;
      u.exposure.value = opts.realisticGloss ? 1.11 : 1.08;
      u.saturation.value = 1.06;
      u.lit_layers.value.set(opts.layerTop, opts.layerTop);
      u.grey_below_layer.value = -1;
      u.dim_brightness.value = opts.dimLowerLayers && opts.layerTop > opts.layerBottom ? 0.42 : -1.0;
      u.kept_vertex.value = -1;
    };

    applyCommon(this.opaqueMat, 0, this.opaqueCount, false);
    applyCommon(this.travelMat, this.opaqueCount, this.travelCount, true);
  }

  public dispose() {
    this.positionTex.dispose();
    this.hwaTex.dispose();
    this.colorTex.dispose();
    this.shadowDummyTex.dispose();
    this.indexTex.dispose();
    this.opaqueGeom.dispose();
    this.travelGeom.dispose();
    this.opaqueMat.dispose();
    this.travelMat.dispose();
  }
}
