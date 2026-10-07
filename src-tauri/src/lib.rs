use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use quick_xml::events::Event;
use quick_xml::reader::Reader;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

#[derive(Serialize, Clone, Debug)]
struct CategoryInfo {
    value: String,
    label: String,
    color: String,
}

#[derive(Serialize, Clone, Debug)]
struct GraduatedRangeInfo {
    lower: f64,
    upper: f64,
    label: String,
    color: String,
}

#[derive(Serialize, Clone, Debug)]
struct LabelingInfo {
    field: String,
    group_by_field: Option<String>,
}

fn extract_group_by_field(filter_expr: &str) -> Option<String> {
    let marker = "group_by:=\"";
    let start = filter_expr.find(marker)? + marker.len();
    let rest = &filter_expr[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

#[derive(Serialize, Clone, Debug)]
struct LayerInfo {
    name: String,
    geometry_type: String,
    datasource: String,
    color: Option<String>,
    category_field: Option<String>,
    categories: Option<Vec<CategoryInfo>>,
    ranges: Option<Vec<GraduatedRangeInfo>>,
    labeling: Option<LabelingInfo>,
}

#[derive(Serialize, Clone, Debug)]
struct BasemapCandidateInfo {
    name: String,
    kind: String,
    datasource: String,
}

fn classify_basemap_datasource(datasource: &str) -> Option<String> {
    let lower = datasource.to_lowercase();
    if lower.contains("type=xyz") || lower.contains("type=wms") || lower.starts_with("http://") || lower.starts_with("https://") || lower.contains("url=http") {
        return Some("external_tile".to_string());
    }
    if lower.ends_with(".tif") || lower.ends_with(".tiff") || lower.contains(".tif|") || lower.contains(".tiff|") {
        return Some("local_raster".to_string());
    }
    None
}

fn parse_basemap_candidates(xml_content: &str) -> Result<Vec<BasemapCandidateInfo>, String> {
    let mut reader = Reader::from_str(xml_content);
    reader.config_mut().trim_text(true);

    let mut candidates = Vec::new();
    let mut buf = Vec::new();

    let mut in_maplayer = false;
    let mut in_layername = false;
    let mut in_datasource = false;
    let mut current_layer_type: Option<String> = None;
    let mut current_name: Option<String> = None;
    let mut current_datasource = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.name().as_ref() == b"maplayer" => {
                in_maplayer = true;
                current_layer_type = None;
                current_name = None;
                current_datasource = String::new();
                for attr_result in e.attributes() {
                    if let Ok(attr) = attr_result {
                        if attr.key.as_ref() == b"type" {
                            if let Ok(value) = attr.unescape_value() {
                                current_layer_type = Some(value.to_lowercase());
                            }
                        }
                    }
                }
            }
            Ok(Event::Start(e)) if in_maplayer && e.name().as_ref() == b"layername" => {
                in_layername = true;
            }
            Ok(Event::Text(e)) if in_layername => {
                if let Ok(text) = e.unescape() {
                    current_name = Some(text.trim().to_string());
                }
                in_layername = false;
            }
            Ok(Event::Start(e)) if in_maplayer && e.name().as_ref() == b"datasource" => {
                in_datasource = true;
            }
            Ok(Event::Text(e)) if in_datasource => {
                if let Ok(text) = e.unescape() {
                    current_datasource = text.trim().to_string();
                }
            }
            Ok(Event::End(e)) if e.name().as_ref() == b"datasource" => {
                in_datasource = false;
            }
            Ok(Event::End(e)) if e.name().as_ref() == b"maplayer" => {
                let is_raster_type = match &current_layer_type {
                    Some(t) => t == "raster" || t == "wms" || t == "wmts",
                    None => false,
                };
                if is_raster_type {
                    if let Some(kind) = classify_basemap_datasource(&current_datasource) {
                        candidates.push(BasemapCandidateInfo {
                            name: current_name.clone().unwrap_or_else(|| "Basemap tanpa nama".to_string()),
                            kind,
                            datasource: current_datasource.clone(),
                        });
                    }
                }
                in_maplayer = false;
            }
            Ok(Event::Eof) => break,
            Err(err) => return Err(format!("Gagal parsing XML: {err}")),
            _ => {}
        }
        buf.clear();
    }

    Ok(candidates)
}

#[tauri::command]
fn parse_qgis_basemap_candidates(path: String) -> Result<Vec<BasemapCandidateInfo>, String> {
    let xml_content = extract_qgs_content(&path)?;
    parse_basemap_candidates(&xml_content)
}

fn project_settings_path(project_path: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(format!("{project_path}.gis2web.json"))
}

#[tauri::command]
fn load_project_settings(project_path: String) -> Result<Option<String>, String> {
    let path = project_settings_path(&project_path);
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("Gagal membaca pengaturan project: {e}"))
}

#[tauri::command]
fn save_project_settings(project_path: String, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| format!("Format pengaturan tidak valid: {e}"))?;
    let path = project_settings_path(&project_path);
    let tmp = std::path::PathBuf::from(format!("{project_path}.gis2web.json.tmp"));
    std::fs::write(&tmp, json).map_err(|e| format!("Gagal menulis pengaturan project: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Gagal menyimpan pengaturan project: {e}"))
}

#[tauri::command]
fn check_gdal_available() -> bool {
    Command::new("gdal2tiles.py")
        .arg("--version")
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

#[tauri::command]
fn generate_tile_pyramid(
    raster_path: String,
    output_dir: String,
    min_zoom: u32,
    max_zoom: u32,
) -> Result<String, String> {
    let raster = Path::new(&raster_path);
    if !raster.exists() {
        return Err(format!("File raster tidak ditemukan: {raster_path}"));
    }

    let tiles_dir = Path::new(&output_dir).join("tiles");
    std::fs::create_dir_all(&tiles_dir)
        .map_err(|e| format!("Gagal membuat folder tiles: {e}"))?;

    let zoom_arg = format!("{min_zoom}-{max_zoom}");

    let output = Command::new("gdal2tiles.py")
        .arg("-p")
        .arg("mercator")
        .arg("-z")
        .arg(&zoom_arg)
        .arg("-w")
        .arg("none")
        .arg(&raster_path)
        .arg(tiles_dir.to_string_lossy().to_string())
        .output()
        .map_err(|e| format!("Gagal menjalankan gdal2tiles.py: {e}. Pastikan GDAL terinstall dan ada di PATH."))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gdal2tiles.py gagal: {stderr}"));
    }

    Ok(tiles_dir.to_string_lossy().to_string())
}

fn rgba_string_to_hex(value: &str) -> Option<String> {
    let parts: Vec<&str> = value.split(',').collect();
    if parts.len() < 3 {
        return None;
    }
    let r: u8 = parts[0].trim().parse().ok()?;
    let g: u8 = parts[1].trim().parse().ok()?;
    let b: u8 = parts[2].trim().parse().ok()?;
    Some(format!("#{:02x}{:02x}{:02x}", r, g, b))
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

fn extract_qgs_content(path: &str) -> Result<String, String> {
    let file_path = Path::new(path);
    let extension = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if extension == "qgs" {
        let mut content = String::new();
        File::open(file_path)
            .map_err(|e| format!("Gagal membuka file: {e}"))?
            .read_to_string(&mut content)
            .map_err(|e| format!("Gagal membaca file: {e}"))?;
        Ok(content)
    } else if extension == "qgz" {
        let file = File::open(file_path).map_err(|e| format!("Gagal membuka file: {e}"))?;
        let mut archive =
            zip::ZipArchive::new(file).map_err(|e| format!("Gagal membuka ZIP: {e}"))?;

        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("Gagal membaca entry ZIP: {e}"))?;
            let name = entry.name().to_string();
            if name.to_lowercase().ends_with(".qgs") {
                let mut content = String::new();
                entry
                    .read_to_string(&mut content)
                    .map_err(|e| format!("Gagal membaca isi .qgs: {e}"))?;
                return Ok(content);
            }
        }
        Err("Tidak ditemukan file .qgs di dalam .qgz".to_string())
    } else {
        Err(format!("Ekstensi file tidak didukung: {extension}"))
    }
}

fn normalize_geometry_type(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("polygon") {
        "Polygon".to_string()
    } else if lower.contains("line") {
        "Line".to_string()
    } else if lower.contains("point") {
        "Point".to_string()
    } else if lower.contains("nogeometry") || lower.contains("none") {
        "NoGeometry".to_string()
    } else {
        "Unknown".to_string()
    }
}

fn parse_layers(xml_content: &str) -> Result<Vec<LayerInfo>, String> {
    let mut reader = Reader::from_str(xml_content);
    reader.config_mut().trim_text(true);

    let mut layers = Vec::new();
    let mut buf = Vec::new();

    let mut in_maplayer = false;
    let mut in_layername = false;
    let mut in_datasource = false;
    let mut in_renderer = false;
    let mut renderer_type: Option<String> = None;
    let mut in_symbol_sublayer = false;
    let mut color_found = false;
    let mut current_geometry = "Unknown".to_string();
    let mut current_layer_type: Option<String> = None;
    let mut current_name: Option<String> = None;
    let mut current_datasource = String::new();
    let mut current_color: Option<String> = None;
    let mut current_category_field: Option<String> = None;
    let mut current_categories: Vec<CategoryInfo> = Vec::new();
    let mut category_defs: Vec<(String, String)> = Vec::new(); // (symbol_id, value)
    let mut symbol_colors: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut in_categories = false;
    let mut in_symbols = false;
    let mut current_symbol_id: Option<String> = None;
    let mut in_current_symbol_layer = false;
    let mut in_ranges = false;
    let mut range_defs: Vec<(String, f64, f64, String)> = Vec::new(); // (symbol_id, lower, upper, label)
    let mut in_labeling = false;
    let mut labeling_type: Option<String> = None;
    let mut current_label_field: Option<String> = None;
    let mut current_label_group_by: Option<String> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.name().as_ref() == b"maplayer" => {
                in_maplayer = true;
                current_geometry = "Unknown".to_string();
                current_layer_type = None;
                current_name = None;
                current_datasource = String::new();
                current_color = None;
                color_found = false;
                renderer_type = None;
                in_symbol_sublayer = false;
                current_category_field = None;
                current_categories = Vec::new();
                category_defs = Vec::new();
                symbol_colors = std::collections::HashMap::new();
                in_categories = false;
                in_symbols = false;
                current_symbol_id = None;
                in_current_symbol_layer = false;
                in_ranges = false;
                range_defs = Vec::new();
                in_labeling = false;
                labeling_type = None;
                current_label_field = None;
                current_label_group_by = None;

                for attr_result in e.attributes() {
                    if let Ok(attr) = attr_result {
                        if attr.key.as_ref() == b"geometry" {
                            if let Ok(value) = attr.unescape_value() {
                                current_geometry = normalize_geometry_type(&value);
                            }
                        } else if attr.key.as_ref() == b"type" {
                            if let Ok(value) = attr.unescape_value() {
                                current_layer_type = Some(value.to_lowercase());
                            }
                        }
                    }
                }
            }
            Ok(Event::Start(e)) if in_maplayer && e.name().as_ref() == b"layername" => {
                in_layername = true;
            }
            Ok(Event::Start(e)) if in_maplayer && e.name().as_ref() == b"datasource" => {
                in_datasource = true;
            }
            Ok(Event::Start(e)) if in_maplayer && e.name().as_ref() == b"labeling" => {
                in_labeling = true;
                for attr_result in e.attributes() {
                    if let Ok(attr) = attr_result {
                        if attr.key.as_ref() == b"type" {
                            if let Ok(v) = attr.unescape_value() {
                                labeling_type = Some(v.to_string());
                            }
                        }
                    }
                }
            }
            Ok(Event::End(e)) if e.name().as_ref() == b"labeling" => {
                in_labeling = false;
            }
            Ok(Event::Start(e)) | Ok(Event::Empty(e))
                if in_labeling
                    && labeling_type.as_deref() == Some("rule-based")
                    && current_label_group_by.is_none()
                    && e.name().as_ref() == b"rule" =>
            {
                for attr_result in e.attributes() {
                    if let Ok(attr) = attr_result {
                        if attr.key.as_ref() == b"filter" {
                            if let Ok(v) = attr.unescape_value() {
                                current_label_group_by = extract_group_by_field(&v);
                            }
                        }
                    }
                }
            }
            Ok(Event::Start(e)) | Ok(Event::Empty(e))
                if in_labeling
                    && current_label_field.is_none()
                    && e.name().as_ref() == b"text-style" =>
            {
                for attr_result in e.attributes() {
                    if let Ok(attr) = attr_result {
                        if attr.key.as_ref() == b"fieldName" {
                            if let Ok(v) = attr.unescape_value() {
                                if !v.is_empty() {
                                    current_label_field = Some(v.to_string());
                                }
                            }
                        }
                    }
                }
            }
            Ok(Event::Start(e)) if in_maplayer && e.name().as_ref() == b"renderer-v2" => {
                in_renderer = true;
                renderer_type = None;
                for attr_result in e.attributes() {
                    if let Ok(attr) = attr_result {
                        if attr.key.as_ref() == b"type" {
                            if let Ok(v) = attr.unescape_value() {
                                renderer_type = Some(v.to_string());
                            }
                        } else if attr.key.as_ref() == b"attr" {
                            if let Ok(v) = attr.unescape_value() {
                                current_category_field = Some(v.to_string());
                            }
                        }
                    }
                }
            }
            Ok(Event::Start(e))
                if in_renderer
                    && renderer_type.as_deref() == Some("categorizedSymbol")
                    && e.name().as_ref() == b"categories" =>
            {
                in_categories = true;
            }
            Ok(Event::Start(e))
                if in_renderer
                    && renderer_type.as_deref() == Some("graduatedSymbol")
                    && e.name().as_ref() == b"ranges" =>
            {
                in_ranges = true;
            }
            Ok(Event::End(e)) if e.name().as_ref() == b"ranges" => {
                in_ranges = false;
            }
            Ok(Event::Empty(e)) if in_ranges && e.name().as_ref() == b"range" => {
                let mut r_lower: Option<f64> = None;
                let mut r_upper: Option<f64> = None;
                let mut r_label: Option<String> = None;
                let mut r_symbol: Option<String> = None;
                for attr_result in e.attributes() {
                    if let Ok(attr) = attr_result {
                        match attr.key.as_ref() {
                            b"lower" => {
                                if let Ok(v) = attr.unescape_value() {
                                    r_lower = v.parse::<f64>().ok();
                                }
                            }
                            b"upper" => {
                                if let Ok(v) = attr.unescape_value() {
                                    r_upper = v.parse::<f64>().ok();
                                }
                            }
                            b"label" => {
                                if let Ok(v) = attr.unescape_value() {
                                    r_label = Some(v.to_string());
                                }
                            }
                            b"symbol" => {
                                if let Ok(v) = attr.unescape_value() {
                                    r_symbol = Some(v.to_string());
                                }
                            }
                            _ => {}
                        }
                    }
                }
                if let (Some(sym), Some(lo), Some(hi)) = (r_symbol, r_lower, r_upper) {
                    let label = r_label.unwrap_or_else(|| format!("{lo} - {hi}"));
                    range_defs.push((sym, lo, hi, label));
                }
            }
            Ok(Event::End(e)) if e.name().as_ref() == b"categories" => {
                in_categories = false;
            }
            Ok(Event::Empty(e)) if in_categories && e.name().as_ref() == b"category" => {
                let mut cat_value: Option<String> = None;
                let mut cat_label: Option<String> = None;
                let mut cat_symbol: Option<String> = None;
                for attr_result in e.attributes() {
                    if let Ok(attr) = attr_result {
                        match attr.key.as_ref() {
                            b"value" => {
                                if let Ok(v) = attr.unescape_value() {
                                    cat_value = Some(v.to_string());
                                }
                            }
                            b"label" => {
                                if let Ok(v) = attr.unescape_value() {
                                    cat_label = Some(v.to_string());
                                }
                            }
                            b"symbol" => {
                                if let Ok(v) = attr.unescape_value() {
                                    cat_symbol = Some(v.to_string());
                                }
                            }
                            _ => {}
                        }
                    }
                }
                if let (Some(sym), Some(val)) = (cat_symbol, cat_value) {
                    let label = cat_label.unwrap_or_else(|| val.clone());
                    category_defs.push((sym, val));
                    if let Some(idx) = category_defs.len().checked_sub(1) {
                        let _ = idx;
                    }
                    current_categories.push(CategoryInfo {
                        value: category_defs.last().unwrap().1.clone(),
                        label,
                        color: String::new(),
                    });
                }
            }
            Ok(Event::Start(e))
                if in_renderer
                    && (renderer_type.as_deref() == Some("categorizedSymbol")
                        || renderer_type.as_deref() == Some("graduatedSymbol"))
                    && e.name().as_ref() == b"symbols" =>
            {
                in_symbols = true;
            }
            Ok(Event::End(e)) if e.name().as_ref() == b"symbols" => {
                in_symbols = false;
            }
            Ok(Event::Start(e)) if in_symbols && e.name().as_ref() == b"symbol" => {
                current_symbol_id = None;
                for attr_result in e.attributes() {
                    if let Ok(attr) = attr_result {
                        if attr.key.as_ref() == b"name" {
                            if let Ok(v) = attr.unescape_value() {
                                current_symbol_id = Some(v.to_string());
                            }
                        }
                    }
                }
            }
            Ok(Event::Start(e)) | Ok(Event::Empty(e))
                if in_symbols && current_symbol_id.is_some() && e.name().as_ref() == b"layer" =>
            {
                in_current_symbol_layer = true;
            }
            Ok(Event::End(e)) if in_symbols && e.name().as_ref() == b"layer" => {
                in_current_symbol_layer = false;
            }
            Ok(Event::Empty(e))
                if in_current_symbol_layer && e.name().as_ref() == b"Option" =>
            {
                let mut opt_name: Option<String> = None;
                let mut opt_val: Option<String> = None;
                for attr_result in e.attributes() {
                    if let Ok(attr) = attr_result {
                        if attr.key.as_ref() == b"name" {
                            if let Ok(v) = attr.unescape_value() {
                                opt_name = Some(v.to_string());
                            }
                        } else if attr.key.as_ref() == b"value" {
                            if let Ok(v) = attr.unescape_value() {
                                opt_val = Some(v.to_string());
                            }
                        }
                    }
                }
                if opt_name.as_deref() == Some("color") {
                    if let (Some(sym_id), Some(v)) = (current_symbol_id.clone(), opt_val) {
                        if let Some(hex) = rgba_string_to_hex(&v) {
                            symbol_colors.entry(sym_id).or_insert(hex);
                        }
                    }
                }
            }
            Ok(Event::End(e)) if e.name().as_ref() == b"renderer-v2" => {
                in_renderer = false;
                in_symbol_sublayer = false;
            }
            // Format QGIS lama (<=2.x): <prop k="color" v="r,g,b,a"/>
            Ok(Event::Empty(e)) if in_renderer && !color_found && e.name().as_ref() == b"prop" => {
                let mut prop_key: Option<String> = None;
                let mut prop_val: Option<String> = None;
                for attr_result in e.attributes() {
                    if let Ok(attr) = attr_result {
                        if attr.key.as_ref() == b"k" {
                            if let Ok(v) = attr.unescape_value() {
                                prop_key = Some(v.to_string());
                            }
                        } else if attr.key.as_ref() == b"v" {
                            if let Ok(v) = attr.unescape_value() {
                                prop_val = Some(v.to_string());
                            }
                        }
                    }
                }
                if prop_key.as_deref() == Some("color") {
                    if let Some(v) = prop_val {
                        if let Some(hex) = rgba_string_to_hex(&v) {
                            current_color = Some(hex);
                            color_found = true;
                        }
                    }
                }
            }
            // Format QGIS modern (>=3.x), khusus singleSymbol:
            // <layer class="SimpleFill"><Option type="Map">
            //   <Option type="QString" name="color" value="r,g,b,a,..."/>
            Ok(Event::Start(e)) | Ok(Event::Empty(e))
                if in_renderer
                    && !color_found
                    && renderer_type.as_deref() == Some("singleSymbol")
                    && e.name().as_ref() == b"layer" =>
            {
                in_symbol_sublayer = true;
            }
            Ok(Event::End(e)) if e.name().as_ref() == b"layer" => {
                in_symbol_sublayer = false;
            }
            Ok(Event::Empty(e))
                if in_symbol_sublayer && !color_found && e.name().as_ref() == b"Option" =>
            {
                let mut opt_name: Option<String> = None;
                let mut opt_val: Option<String> = None;
                for attr_result in e.attributes() {
                    if let Ok(attr) = attr_result {
                        if attr.key.as_ref() == b"name" {
                            if let Ok(v) = attr.unescape_value() {
                                opt_name = Some(v.to_string());
                            }
                        } else if attr.key.as_ref() == b"value" {
                            if let Ok(v) = attr.unescape_value() {
                                opt_val = Some(v.to_string());
                            }
                        }
                    }
                }
                if opt_name.as_deref() == Some("color") {
                    if let Some(v) = opt_val {
                        if let Some(hex) = rgba_string_to_hex(&v) {
                            current_color = Some(hex);
                            color_found = true;
                        }
                    }
                }
            }
            Ok(Event::Text(e)) if in_layername => {
                let text = e
                    .unescape()
                    .map_err(|err| format!("Gagal parsing XML: {err}"))?
                    .to_string();
                if !text.trim().is_empty() {
                    current_name = Some(text.trim().to_string());
                }
            }
            Ok(Event::Text(e)) if in_datasource => {
                let text = e
                    .unescape()
                    .map_err(|err| format!("Gagal parsing XML: {err}"))?
                    .to_string();
                current_datasource = text.trim().to_string();
            }
            Ok(Event::End(e)) if e.name().as_ref() == b"layername" => {
                in_layername = false;
            }
            Ok(Event::End(e)) if e.name().as_ref() == b"datasource" => {
                in_datasource = false;
            }
            Ok(Event::End(e)) if e.name().as_ref() == b"maplayer" => {
                // Hanya layer vektor yang relevan untuk Web GIS. Layer raster
                // (mis. gambar/screenshot yang tidak sengaja ikut tersimpan
                // di project QGIS) atau tipe lain (mesh, plugin, dsb) tidak
                // dimasukkan ke daftar layer.
                let is_vector_layer = match &current_layer_type {
                    Some(t) => t == "vector",
                    None => true, // beberapa versi QGIS tidak menulis atribut type; anggap vector agar tidak menghapus layer yang valid
                };

                if let Some(name) = current_name.take().filter(|_| is_vector_layer) {
                    let final_categories = if category_defs.is_empty() {
                        None
                    } else {
                        let mut result = Vec::new();
                        for (sym_id, val) in &category_defs {
                            let color = symbol_colors
                                .get(sym_id)
                                .cloned()
                                .unwrap_or_else(|| "#9ca3af".to_string());
                            let label = if val == "NULL" {
                                "Lainnya".to_string()
                            } else {
                                val.clone()
                            };
                            result.push(CategoryInfo {
                                value: val.clone(),
                                label,
                                color,
                            });
                        }
                        Some(result)
                    };

                    let final_ranges = if range_defs.is_empty() {
                        None
                    } else {
                        let mut result = Vec::new();
                        for (sym_id, lo, hi, label) in &range_defs {
                            let color = symbol_colors
                                .get(sym_id)
                                .cloned()
                                .unwrap_or_else(|| "#9ca3af".to_string());
                            result.push(GraduatedRangeInfo {
                                lower: *lo,
                                upper: *hi,
                                label: label.clone(),
                                color,
                            });
                        }
                        Some(result)
                    };

                    let final_labeling = current_label_field.take().map(|field| LabelingInfo {
                        field,
                        group_by_field: current_label_group_by.take(),
                    });

                    layers.push(LayerInfo {
                        name,
                        geometry_type: current_geometry.clone(),
                        datasource: current_datasource.clone(),
                        color: current_color.take(),
                        category_field: current_category_field.take(),
                        categories: final_categories,
                        ranges: final_ranges,
                        labeling: final_labeling,
                    });
                }
                in_maplayer = false;
            }
            Ok(Event::Eof) => break,
            Err(err) => return Err(format!("Gagal parsing XML: {err}")),
            _ => {}
        }
        buf.clear();
    }

    Ok(layers)
}

#[tauri::command]
fn parse_qgis_project(path: String) -> Result<Vec<LayerInfo>, String> {
    let xml_content = extract_qgs_content(&path)?;
    parse_layers(&xml_content)
}

fn find_file_by_basename(search_root: &Path, basename: &str) -> Option<PathBuf> {
    for entry in WalkDir::new(search_root)
        .max_depth(6)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            if let Some(name) = entry.file_name().to_str() {
                if name == basename {
                    return Some(entry.path().to_path_buf());
                }
            }
        }
    }
    None
}

fn resolve_data_path(project_dir: &Path, raw_path: &str) -> Result<PathBuf, String> {
    let cleaned = raw_path.trim_start_matches("file:");
    let candidate = project_dir.join(cleaned);

    if candidate.exists() {
        return Ok(candidate);
    }

    let basename = Path::new(cleaned)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("Path data tidak valid: {raw_path}"))?;

    if let Some(found) = find_file_by_basename(project_dir, basename) {
        return Ok(found);
    }

    Err(format!(
        "File data tidak ditemukan: {basename} (path asli: {raw_path})"
    ))
}

fn run_ogr2ogr(args: &[String]) -> Result<String, String> {
    let candidates = ["ogr2ogr", "/opt/homebrew/bin/ogr2ogr", "/usr/local/bin/ogr2ogr"];

    let mut last_error = String::new();
    for bin in candidates {
        match Command::new(bin).args(args).output() {
            Ok(output) => {
                if output.status.success() {
                    return Ok(String::new());
                } else {
                    last_error = String::from_utf8_lossy(&output.stderr).to_string();
                }
            }
            Err(e) => {
                last_error = e.to_string();
                continue;
            }
        }
    }
    Err(format!("Gagal menjalankan ogr2ogr: {last_error}"))
}

fn unique_temp_geojson_path() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("gis2web_{nanos}.geojson"))
}

#[tauri::command]
fn get_layer_geojson(project_path: String, datasource: String) -> Result<String, String> {
    if datasource.trim().is_empty() {
        return Err("Layer tidak memiliki sumber data (kosong)".to_string());
    }
    if datasource.contains("type=xyz") || datasource.starts_with("crs=") {
        return Err("Layer ini adalah basemap/tile, bukan data vektor".to_string());
    }

    let project_dir = Path::new(&project_path)
        .parent()
        .ok_or("Tidak dapat menentukan folder project")?
        .to_path_buf();

    let output_path = unique_temp_geojson_path();
    let output_path_str = output_path.to_string_lossy().to_string();

    let source_args: Vec<String>;

    if datasource.starts_with("/vsizip/") {
        // Format: /vsizip/<path ke .zip>/<file di dalam zip>|layername=<nama>
        let without_prefix = datasource.trim_start_matches("/vsizip/");
        let (inner_path, layer_name) = match without_prefix.split_once("|layername=") {
            Some((p, l)) => (p.to_string(), l.to_string()),
            None => (without_prefix.to_string(), String::new()),
        };

        // Pisahkan path ZIP dan file di dalamnya (dipisah setelah ".zip")
        let zip_marker = ".zip";
        let zip_pos = inner_path
            .find(zip_marker)
            .ok_or_else(|| format!("Format vsizip tidak dikenali: {datasource}"))?;
        let zip_path_raw = &inner_path[..zip_pos + zip_marker.len()];
        let file_inside_zip = inner_path[zip_pos + zip_marker.len()..]
            .trim_start_matches('/')
            .to_string();

        let resolved_zip = resolve_data_path(&project_dir, zip_path_raw)?;
        let vsizip_path = format!(
            "/vsizip/{}/{}",
            resolved_zip.to_string_lossy(),
            file_inside_zip
        );

        let mut args = vec![
            "-f".to_string(),
            "GeoJSON".to_string(),
            "-t_srs".to_string(),
            "EPSG:4326".to_string(),
            output_path_str.clone(),
            vsizip_path,
        ];
        if !layer_name.is_empty() {
            args.push(layer_name);
        }
        source_args = args;
    } else if datasource.contains(".gpkg|layername=") {
        let parts: Vec<&str> = datasource.splitn(2, "|layername=").collect();
        let raw_path = parts[0];
        let layer_name = parts.get(1).unwrap_or(&"").to_string();
        let resolved = resolve_data_path(&project_dir, raw_path)?;
        source_args = vec![
            "-f".to_string(),
            "GeoJSON".to_string(),
            "-t_srs".to_string(),
            "EPSG:4326".to_string(),
            output_path_str.clone(),
            resolved.to_string_lossy().to_string(),
            layer_name,
        ];
    } else if datasource.starts_with("file:") && datasource.contains(".csv") {
        let path_part = datasource
            .trim_start_matches("file:")
            .split('?')
            .next()
            .unwrap_or("")
            .to_string();
        let query_part = datasource.split('?').nth(1).unwrap_or("");

        let mut x_field = "longitude".to_string();
        let mut y_field = "latitude".to_string();
        for kv in query_part.split('&') {
            if let Some((k, v)) = kv.split_once('=') {
                if k == "xField" {
                    x_field = v.to_string();
                } else if k == "yField" {
                    y_field = v.to_string();
                }
            }
        }

        let resolved = resolve_data_path(&project_dir, &path_part)?;
        source_args = vec![
            "-f".to_string(),
            "GeoJSON".to_string(),
            "-t_srs".to_string(),
            "EPSG:4326".to_string(),
            output_path_str.clone(),
            resolved.to_string_lossy().to_string(),
            "-oo".to_string(),
            format!("X_POSSIBLE_NAMES={x_field}"),
            "-oo".to_string(),
            format!("Y_POSSIBLE_NAMES={y_field}"),
        ];
    } else {
        let resolved = resolve_data_path(&project_dir, &datasource)?;
        source_args = vec![
            "-f".to_string(),
            "GeoJSON".to_string(),
            "-t_srs".to_string(),
            "EPSG:4326".to_string(),
            output_path_str.clone(),
            resolved.to_string_lossy().to_string(),
        ];
    }

    run_ogr2ogr(&source_args)?;

    let mut geojson_content = String::new();
    File::open(&output_path)
        .map_err(|e| format!("Gagal membuka hasil konversi: {e}"))?
        .read_to_string(&mut geojson_content)
        .map_err(|e| format!("Gagal membaca hasil konversi: {e}"))?;

    let _ = std::fs::remove_file(&output_path);

    Ok(geojson_content)
}


fn slugify(name: &str) -> String {
    let mut result = String::new();
    let mut last_was_underscore = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            result.push(c.to_ascii_lowercase());
            last_was_underscore = false;
        } else if !last_was_underscore {
            result.push('_');
            last_was_underscore = true;
        }
    }
    let trimmed = result.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "layer".to_string()
    } else {
        trimmed
    }
}

#[derive(Deserialize, Clone, Debug)]
struct ExportCategoryInput {
    value: String,
    color: String,
}

#[derive(Deserialize, Clone, Debug)]
struct ExportRangeInput {
    lower: f64,
    upper: f64,
    label: String,
    color: String,
}

#[derive(Deserialize, Clone, Debug)]
struct ExportLabelingInput {
    field: String,
    group_by_field: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
struct ExportLayerInput {
    layer_index: usize,
    name: String,
    datasource: String,
    geometry_type: String,
    color: String,
    opacity: f64,
    point_size: f64,
    category_field: Option<String>,
    categories: Option<Vec<ExportCategoryInput>>,
    ranges: Option<Vec<ExportRangeInput>>,
    labeling: Option<ExportLabelingInput>,
    visible_fields: Option<Vec<String>>,
    is_boundary: bool,
    show_attribute_table: bool,
}

#[derive(Deserialize, Clone, Debug)]
struct ExportConfig {
    #[allow(dead_code)]
    basemap: String,
    min_zoom: u32,
    max_zoom: u32,
    tile_url: String,
    attribution: String,
    label_font_size: f64,
    export_title: Option<String>,
    export_logo_path: Option<String>,
    export_logo_png: Option<Vec<u8>>,
    label_positions: Option<std::collections::HashMap<String, (f64, f64)>>,
    show_legend: Option<bool>,
}

fn escape_export_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn build_index_html() -> String {
    r#"<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>GIS2Web Studio Export</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/@turf/turf@6.5.0/turf.min.js"></script>
<script src="https://unpkg.com/@turf/turf@6.5.0/turf.min.js"></script>
<link rel="stylesheet" href="css/style.css" />
</head>
<body>
<div id="map"></div>
<div id="feature-info-card" class="feature-info-card" hidden>
  <div class="feature-info-card-header">
    <div class="feature-info-card-header-text">
      <div id="feature-info-card-title" class="feature-info-card-title"></div>
      <div id="feature-info-card-subtitle" class="feature-info-card-subtitle"></div>
    </div>
    <button type="button" id="feature-info-card-close" class="feature-info-card-close">&times;</button>
  </div>
  <div class="feature-info-card-body">
    <table id="feature-info-card-table" class="feature-info-card-table"></table>
  </div>
</div>
<div id="layer-toggle-panel" class="layer-toggle-panel" hidden>
  <div class="layer-toggle-header">
    <span class="layer-toggle-title">Layer</span>
    <button type="button" id="layer-toggle-collapse-btn" class="layer-toggle-collapse-btn">&#9660;</button>
  </div>
  <div id="layer-toggle-list" class="layer-toggle-list"></div>
</div>
<div id="attribute-table-panel" class="attribute-table-panel" hidden>
  <div class="attribute-table-header">
    <div class="attribute-table-header-left">
      <span class="attribute-table-title">Attribute Table</span>
      <select id="attribute-table-layer-select" class="attribute-table-layer-select"></select>
      <span id="attribute-table-count" class="attribute-table-count"></span>
    </div>
    <button type="button" id="attribute-table-toggle-btn" class="attribute-table-toggle-btn">&#9660;</button>
  </div>
  <div id="attribute-table-body" class="attribute-table-body">
    <div class="attribute-table-scroll">
      <table id="attribute-data-table" class="attribute-data-table"></table>
    </div>
  </div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="js/app.js"></script>
</body>
</html>
"#.to_string()
}

fn build_style_css() -> String {
    r#"html, body, #map {
  height: 100%;
  width: 100%;
  margin: 0;
  padding: 0;
}

.feature-info-card {
  position: absolute;
  top: 1rem;
  right: 1rem;
  z-index: 1100;
  width: 340px;
  max-width: calc(100vw - 2rem);
  max-height: calc(100% - 2rem);
  background: #ffffff;
  border: 1px solid #e7e7ee;
  border-radius: 18px;
  box-shadow: 0 12px 36px rgba(16, 16, 30, 0.16);
  display: flex;
  flex-direction: column;
  font-family: -apple-system, "Inter", Helvetica, Arial, sans-serif;
  overflow: hidden;
}

.feature-info-card[hidden] {
  display: none;
}

.feature-info-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.6rem;
  padding: 0.85rem 0.9rem 0.7rem;
  border-bottom: 1px solid #e7e7ee;
  flex-shrink: 0;
}

.feature-info-card-header-text {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}

.feature-info-card-title {
  font-size: 0.92rem;
  font-weight: 700;
  color: #18181b;
}

.feature-info-card-subtitle {
  font-size: 0.75rem;
  color: #71717a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.feature-info-card-close {
  background: #fafafa;
  border: 1px solid #e7e7ee;
  width: 26px;
  height: 26px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9rem;
  color: #71717a;
  cursor: pointer;
  flex-shrink: 0;
}

.feature-info-card-close:hover {
  background-color: #eff6ff;
  color: #1d4ed8;
}

.feature-info-card-body {
  overflow-y: auto;
  padding: 0.4rem 0.9rem 0.9rem;
}

.feature-info-card-table {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.82rem;
}

.feature-info-card-table th,
.feature-info-card-table td {
  text-align: left;
  padding: 0.45rem 0;
  border-bottom: 1px solid #e7e7ee;
  vertical-align: top;
}

.feature-info-card-table tr:last-child th,
.feature-info-card-table tr:last-child td {
  border-bottom: none;
}

.feature-info-card-table th {
  color: #a1a1aa;
  font-weight: 600;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  width: 42%;
  padding-right: 0.6rem;
}

.feature-info-card-table td {
  color: #18181b;
  word-break: break-word;
}

/* HP / layar sempit: card menjadi bottom sheet. Peta di atasnya tetap bisa disentuh. */
@media (max-width: 640px) {
  .feature-info-card {
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
    max-width: none;
    max-height: 40vh;
    border-radius: 18px 18px 0 0;
    border-left: none;
    border-right: none;
    border-bottom: none;
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  .feature-info-card-close {
    width: 32px;
    height: 32px;
    font-size: 1.1rem;
  }
  .feature-info-card-table {
    font-size: 0.85rem;
  }
}

.leaflet-popup-content-wrapper {
  border-radius: 12px;
  padding: 0;
}

.leaflet-popup-content {
  margin: 0;
}

.feature-popup {
  padding: 0.5rem;
  max-height: 220px;
  overflow-y: auto;
}

.feature-popup-table {
  border-collapse: collapse;
  font-size: 0.8rem;
}

.feature-popup-table th,
.feature-popup-table td {
  text-align: left;
  padding: 0.3rem 0.6rem;
  border-bottom: 1px solid #e7e7ee;
  vertical-align: top;
}

.feature-popup-table tr:last-child th,
.feature-popup-table tr:last-child td {
  border-bottom: none;
}

.feature-popup-table th {
  color: #a1a1aa;
  font-weight: 600;
  white-space: nowrap;
}

.feature-popup-table td {
  color: #18181b;
  word-break: break-word;
}

.attribute-table-panel {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1200;
  max-height: 45%;
  background: #ffffff;
  border-top: 1px solid #e7e7ee;
  box-shadow: 0 12px 36px rgba(16, 16, 30, 0.16);
  display: flex;
  flex-direction: column;
  font-family: -apple-system, "Inter", Helvetica, Arial, sans-serif;
}

.attribute-table-panel[hidden] {
  display: none;
}

.attribute-table-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid #e7e7ee;
  background: #fafafa;
  flex-shrink: 0;
}

.attribute-table-header-left {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.85rem;
  flex-wrap: wrap;
}

.attribute-table-title {
  font-weight: 700;
  color: #18181b;
}

.attribute-table-layer-select {
  font-size: 0.8rem;
  padding: 0.25rem 0.4rem;
  border-radius: 6px;
  border: 1px solid #e7e7ee;
  background: #ffffff;
}

.attribute-table-count {
  color: #a1a1aa;
  font-size: 0.75rem;
}

.attribute-table-toggle-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 0.75rem;
  color: #71717a;
  padding: 0.2rem 0.5rem;
}

.attribute-table-toggle-btn:hover {
  color: #18181b;
}

.attribute-table-body {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

.attribute-table-body[hidden] {
  display: none;
}

.attribute-table-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.attribute-data-table {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.8rem;
}

.attribute-data-table th,
.attribute-data-table td {
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid #e7e7ee;
  text-align: left;
  white-space: nowrap;
}

.attribute-data-table th {
  position: sticky;
  top: 0;
  background: #fafafa;
  color: #a1a1aa;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.attribute-data-table tbody tr {
  cursor: pointer;
}

.attribute-data-table tbody tr:hover {
  background: #fafafa;
}

.attribute-data-table tbody tr.active-row {
  background: #eff6ff;
}

.layer-toggle-panel {
  position: absolute;
  top: 1rem;
  left: 1rem;
  z-index: 1000;
  background: #ffffff;
  border: 1px solid #d4d4d8;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
  width: 230px;
  max-width: calc(100vw - 2rem);
  max-height: calc(100% - 2rem);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: -apple-system, "Inter", Helvetica, Arial, sans-serif;
  font-size: 0.8rem;
}

.layer-toggle-panel[hidden] {
  display: none;
}

.layer-toggle-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid #e4e4e7;
  flex-shrink: 0;
}

.layer-toggle-title {
  font-weight: 600;
  font-size: 0.8rem;
  color: #18181b;
}

.layer-toggle-collapse-btn {
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #71717a;
  font-size: 0.6rem;
  cursor: pointer;
}

.layer-toggle-collapse-btn:hover {
  background: #f4f4f5;
  color: #18181b;
}

.layer-toggle-list {
  padding: 0.35rem 0.6rem 0.45rem;
  overflow-y: auto;
  scrollbar-width: thin;
}

.layer-toggle-list[hidden] {
  display: none;
}

.layer-toggle-item {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.2rem 0;
  line-height: 1.3;
  color: #18181b;
  cursor: pointer;
}

.layer-toggle-item input[type="checkbox"] {
  accent-color: #2563eb;
  width: 14px;
  height: 14px;
  margin: 0;
  cursor: pointer;
  flex-shrink: 0;
}

.layer-toggle-item span {
  min-width: 0;
  word-break: break-word;
}

.legend-swatch {
  display: inline-block;
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  box-sizing: border-box;
  border: 1px solid transparent;
  border-radius: 2px;
  font-style: normal;
}

.legend-swatch--point {
  width: 10px;
  height: 10px;
  margin: 0 2px;
  border-radius: 50%;
}

.legend-swatch--line {
  width: 16px;
  height: 3px;
  margin: 0 -1px;
  border: none;
  border-radius: 1px;
}

.legend-swatch--boundary {
  background: transparent;
  border-width: 2px;
}

.legend-entries {
  margin: 0 0 0.25rem 1.35rem;
  max-height: 9rem;
  overflow-y: auto;
  scrollbar-width: thin;
}

.legend-entries[hidden] {
  display: none;
}

.legend-entry {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.1rem 0;
  font-size: 0.78rem;
  line-height: 1.3;
  color: #3f3f46;
}

.legend-entry span {
  min-width: 0;
  word-break: break-word;
}

.leaflet-tooltip.layer-feature-label {
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0;
  color: #323232;
  font-weight: 600;
  text-shadow:
    -1px -1px 0 #fafafa,
    1px -1px 0 #fafafa,
    -1px 1px 0 #fafafa,
    1px 1px 0 #fafafa,
    0 0 3px #fafafa;
  white-space: nowrap;
}

.leaflet-tooltip.layer-feature-label::before {
  display: none;
}

.map-flying .layer-feature-label {
  visibility: hidden;
}
"#.to_string()
}

fn build_app_js(config_json: &str) -> String {
    format!(
        r#"const CONFIG = {config_json};

const map = L.map('map', {{ zoomControl: false, doubleClickZoom: false, minZoom: CONFIG.minZoom, maxZoom: CONFIG.maxZoom }});
L.control.zoom({{ position: 'bottomright' }}).addTo(map);

const FocusBoundaryControl = L.Control.extend({{
  onAdd: function () {{
    const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
    const button = L.DomUtil.create('a', '', container);
    button.href = '#';
    button.title = 'Fokus ke Boundary Layer';
    button.setAttribute('role', 'button');
    button.setAttribute('aria-label', 'Fokus ke Boundary Layer');
    button.style.fontSize = '18px';
    button.style.lineHeight = '30px';
    button.style.textAlign = 'center';
    button.innerHTML = '&#8982;';
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.on(button, 'click', function (ev) {{
      L.DomEvent.preventDefault(ev);
      const boundaryCfg = CONFIG.layers.find(function (l) {{ return l.isBoundary; }});
      if (!boundaryCfg) return;
      const gLayer = layerRefs[boundaryCfg.layerIndex];
      if (!gLayer) return;
      const bounds = gLayer.getBounds();
      if (!bounds.isValid()) return;
      const mapEl = map.getContainer();
      mapEl.classList.add('map-flying');
      map.once('moveend', function () {{ mapEl.classList.remove('map-flying'); }});
      if (map.getBoundsZoom(bounds) < CONFIG.minZoom) {{
        map.flyTo(bounds.getCenter(), CONFIG.minZoom, {{ duration: 1.6 }});
      }} else {{
        map.flyToBounds(bounds, {{ maxZoom: CONFIG.maxZoom, duration: 1.6 }});
      }}
    }});
    return container;
  }},
}});
new FocusBoundaryControl({{ position: 'bottomright' }}).addTo(map);

function addBasemap() {{
  L.tileLayer(CONFIG.basemap.url, {{
    attribution: CONFIG.basemap.attribution,
    minZoom: CONFIG.minZoom,
    maxZoom: CONFIG.maxZoom,
    updateWhenIdle: true,
    keepBuffer: 2,
  }}).addTo(map);
}}
if (window.requestIdleCallback) {{
  window.requestIdleCallback(addBasemap, {{ timeout: 800 }});
}} else {{
  setTimeout(addBasemap, 150);
}}

function escapeHtml(value) {{
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}}

// Warna final feature: kalau layer punya kategori (categoryField diisi saat
// konfigurasi di GIS2Web Studio), pakai warna per-kategori; kalau tidak,
// pakai warna solid layer. Ini nilai FINAL, tidak ada UI untuk mengubahnya
// di hasil export.
function resolveFeatureColor(layer, feature) {{
  if (layer.categoryField && layer.categories && layer.categories.length > 0) {{
    const raw = feature && feature.properties ? feature.properties[layer.categoryField] : undefined;
    const valueKey = raw === null || raw === undefined ? 'NULL' : String(raw);
    const match = layer.categories.find((c) => c.value === valueKey);
    return match ? match.color : layer.color;
  }}

  if (layer.categoryField && layer.ranges && layer.ranges.length > 0) {{
    const raw = feature && feature.properties ? feature.properties[layer.categoryField] : undefined;
    const numericValue = typeof raw === 'number' ? raw : parseFloat(raw);
    if (!Number.isNaN(numericValue)) {{
      const match = layer.ranges.find((r) => numericValue >= r.lower && numericValue <= r.upper);
      if (match) return match.color;
    }}
    return layer.color;
  }}

  return layer.color;
}}

function buildFieldsTable(properties, visibleFields) {{
  if (!properties || Object.keys(properties).length === 0) return null;
  const allKeys = Object.keys(properties);
  const fieldsToShow = Array.isArray(visibleFields)
    ? visibleFields.filter((f) => allKeys.includes(f))
    : allKeys;
  if (fieldsToShow.length === 0) return null;

  return fieldsToShow.map((key) => {{
    const value = properties[key];
    return {{ key, value: value === null || value === undefined ? '-' : String(value) }};
  }});
}}

// ---- Feature Information card (mode 'card' / 'both') ----
const cardEl = document.getElementById('feature-info-card');
const cardTitleEl = document.getElementById('feature-info-card-title');
const cardSubtitleEl = document.getElementById('feature-info-card-subtitle');
const cardTableEl = document.getElementById('feature-info-card-table');
const cardCloseBtn = document.getElementById('feature-info-card-close');

function showFeatureCard(layerName, rows) {{
  cardTitleEl.textContent = 'Feature Information';
  cardSubtitleEl.textContent = layerName;
  cardTableEl.innerHTML = rows
    ? rows.map((r) => `<tr><th>${{escapeHtml(r.key)}}</th><td>${{escapeHtml(r.value)}}</td></tr>`).join('')
    : '<tr><td>Tidak ada atribut.</td></tr>';
  cardEl.hidden = false;
}}

function hideFeatureCard() {{
  cardEl.hidden = true;
}}

cardCloseBtn.addEventListener('click', hideFeatureCard);

const layerRefs = {{}};
const layerGeojsonData = {{}};
const featureLayerRefs = {{}};
const layerStyleFns = {{}};
let boundaryFitted = false;
let activeFeatureKey = null;
const clickCycle = {{ point: null, matches: [], index: -1 }};

// ---- Highlight seleksi: strong (feature diklik) / subtle (feature lain di
// layer yang sama). Sama persis dengan getStrongHighlightStyle/
// getSubtleHighlightStyle di layerStyle.ts pada aplikasi. ----
function getStrongHighlightStyle(base) {{
  return Object.assign({{}}, base, {{
    weight: (base.weight || 1.5) + 3,
    color: '#facc15',
    fillOpacity: Math.min((base.fillOpacity || 0.35) + 0.25, 0.85),
  }});
}}
function getSubtleHighlightStyle(base) {{
  return Object.assign({{}}, base, {{
    weight: (base.weight || 1.5) + 1.5,
    fillOpacity: Math.min((base.fillOpacity || 0.35) + 0.1, 0.7),
  }});
}}

// ---- Prioritas hit-test: Point > Line > Polygon. Sama persis dengan
// geometryPriority() di MapView.tsx. ----
function geometryPriority(geomType) {{
  if (geomType === 'Point' || geomType === 'MultiPoint') return 0;
  if (geomType === 'LineString' || geomType === 'MultiLineString') return 1;
  if (geomType === 'Polygon' || geomType === 'MultiPolygon') return 2;
  return 3;
}}

const NEAREST_FEATURE_PIXEL_TOLERANCE = 18;

function getVisibleZOrderedFeatureCandidates(latlng) {{
  const pt = turf.point([latlng.lng, latlng.lat]);
  const candidates = [];
  const nearestByDistance = [];

  const clickPoint = map.latLngToContainerPoint(latlng);
  const toleranceProbe = L.point(clickPoint.x + NEAREST_FEATURE_PIXEL_TOLERANCE, clickPoint.y);
  const toleranceLatLng = map.containerPointToLatLng(toleranceProbe);
  const toleranceMeters = latlng.distanceTo(toleranceLatLng);

  // CONFIG.layers sudah terurut sesuai layerOrder final (layer atas dulu).
  CONFIG.layers.forEach((layerCfg) => {{
    const gLayer = layerRefs[layerCfg.layerIndex];
    if (!gLayer || !map.hasLayer(gLayer)) return;
    const geojsonData = layerGeojsonData[layerCfg.layerIndex];
    if (!geojsonData) return;

    const features = geojsonData.features || [];
    features.forEach((feature, featureIndex) => {{
      const geomType = feature.geometry ? feature.geometry.type : undefined;
      const key = layerCfg.layerIndex + ':' + featureIndex;

      if (geomType === 'Point' || geomType === 'MultiPoint') {{
        const coordsList = geomType === 'Point' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
        for (const c of coordsList) {{
          const d = latlng.distanceTo(L.latLng(c[1], c[0]));
          if (d <= toleranceMeters) {{
            const layerInstance = featureLayerRefs[key];
            if (layerInstance) {{
              nearestByDistance.push({{ layerIndex: layerCfg.layerIndex, featureIndex, layerInstance, geomType, distanceMeters: d }});
            }}
            break;
          }}
        }}
        return;
      }}

      if (geomType === 'LineString' || geomType === 'MultiLineString') {{
        try {{
          const lines = geomType === 'MultiLineString'
            ? feature.geometry.coordinates.map((coords) => turf.lineString(coords))
            : [turf.lineString(feature.geometry.coordinates)];
          for (const line of lines) {{
            const d = turf.pointToLineDistance(pt, line, {{ units: 'meters' }});
            if (d <= toleranceMeters) {{
              const layerInstance = featureLayerRefs[key];
              if (layerInstance) {{
                nearestByDistance.push({{ layerIndex: layerCfg.layerIndex, featureIndex, layerInstance, geomType, distanceMeters: d }});
              }}
              break;
            }}
          }}
        }} catch (e) {{ /* geometry tidak valid, skip */ }}
        return;
      }}

      if (geomType !== 'Polygon' && geomType !== 'MultiPolygon') return;

      try {{
        if (turf.booleanPointInPolygon(pt, feature)) {{
          const layerInstance = featureLayerRefs[key];
          if (layerInstance) {{
            candidates.push({{ layerIndex: layerCfg.layerIndex, featureIndex, layerInstance, geomType, distanceMeters: 0 }});
          }}
          return;
        }}
      }} catch (e) {{ /* geometry tidak valid, coba fallback jarak */ }}

      try {{
        const boundary = turf.polygonToLine(feature);
        const lineFeatures = boundary.type === 'FeatureCollection' ? boundary.features : [boundary];
        const singleLines = [];
        lineFeatures.forEach((lf) => {{
          if (lf.geometry.type === 'LineString') {{
            singleLines.push(lf);
          }} else if (lf.geometry.type === 'MultiLineString') {{
            lf.geometry.coordinates.forEach((coords) => singleLines.push(turf.lineString(coords)));
          }}
        }});
        for (const line of singleLines) {{
          const d = turf.pointToLineDistance(pt, line, {{ units: 'meters' }});
          if (d <= toleranceMeters) {{
            const layerInstance = featureLayerRefs[key];
            if (layerInstance) {{
              nearestByDistance.push({{ layerIndex: layerCfg.layerIndex, featureIndex, layerInstance, geomType, distanceMeters: d }});
            }}
            break;
          }}
        }}
      }} catch (e) {{ /* geometry tidak valid untuk fallback juga, skip */ }}
    }});
  }});

  const merged = candidates.concat(nearestByDistance);
  if (merged.length === 0) return [];
  merged.sort((a, b) => {{
    const p = geometryPriority(a.geomType) - geometryPriority(b.geomType);
    if (p !== 0) return p;
    return a.distanceMeters - b.distanceMeters;
  }});
  return merged;
}}

function applyHighlightForActive() {{
  Object.keys(featureLayerRefs).forEach((key) => {{
    const layerIndexStr = key.split(':')[0];
    const layerIndex = Number(layerIndexStr);
    const layerInstance = featureLayerRefs[key];
    const styleFn = layerStyleFns[layerIndex];
    if (!styleFn || typeof layerInstance.setStyle !== 'function') return;
    const baseStyle = styleFn(layerInstance.feature);

    if (!activeFeatureKey || activeFeatureKey.split(':')[0] !== layerIndexStr) {{
      layerInstance.setStyle(baseStyle);
      return;
    }}
    if (key === activeFeatureKey) {{
      layerInstance.setStyle(getStrongHighlightStyle(baseStyle));
      if (typeof layerInstance.bringToFront === 'function') layerInstance.bringToFront();
    }} else {{
      layerInstance.setStyle(getSubtleHighlightStyle(baseStyle));
    }}
  }});
}}

function closeAllPopups() {{
  Object.keys(featureLayerRefs).forEach((key) => {{
    const l = featureLayerRefs[key];
    if (typeof l.closePopup === 'function') l.closePopup();
  }});
}}

// Fungsi terpusat untuk "memilih" sebuah feature, dipakai baik dari klik
// peta maupun klik row di Attribute Table, supaya highlight/popup/card dan
// sinkronisasi selalu konsisten dari kedua sumber. latlng opsional (row
// Attribute Table tidak selalu punya titik klik di peta).
function selectFeature(layerIndex, featureIndex, latlng) {{
  const key = layerIndex + ':' + featureIndex;
  const layerInstance = featureLayerRefs[key];
  if (!layerInstance) return;

  activeFeatureKey = key;
  applyHighlightForActive();
  closeAllPopups();

  const layerConfig = CONFIG.layers.find((l) => l.layerIndex === layerIndex);
  const geojsonData = layerGeojsonData[layerIndex];
  const feature = geojsonData ? geojsonData.features[featureIndex] : null;
  const rows = layerConfig && feature ? buildFieldsTable(feature.properties, layerConfig.visibleFields) : null;

  showFeatureCard(layerConfig ? layerConfig.name : '', rows);

  syncAttributeTableToActiveFeature();
}}

function handleMapClick(e) {{
  const candidates = getVisibleZOrderedFeatureCandidates(e.latlng);
  if (candidates.length === 0) return;

  const clickPoint = map.latLngToContainerPoint(e.latlng);
  const sameKeys = clickCycle.matches.length === candidates.length &&
    clickCycle.matches.every((m, i) => m.layerIndex === candidates[i].layerIndex && m.featureIndex === candidates[i].featureIndex);
  const closeToPrev = clickCycle.point ? clickCycle.point.distanceTo(clickPoint) < 15 : false;
  const nextIndex = sameKeys && closeToPrev ? (clickCycle.index + 1) % candidates.length : 0;

  clickCycle.point = clickPoint;
  clickCycle.matches = candidates.map((c) => ({{ layerIndex: c.layerIndex, featureIndex: c.featureIndex }}));
  clickCycle.index = nextIndex;

  const selected = candidates[nextIndex];
  selectFeature(selected.layerIndex, selected.featureIndex, e.latlng);
}}

map.on('click', handleMapClick);

// ---- Smart Hover: feature teratas di bawah kursor (hit-test sama dengan
// klik) diberi highlight ringan. Dinonaktifkan di perangkat sentuh. ----
let hoveredFeatureKey = null;

// Port dari getPreviewHighlightStyle (layerStyle.ts): hover berbeda dari
// highlight seleksi (kuning) supaya terbedakan dari feature yang dipilih.
function getPreviewHighlightStyle(base) {{
  return Object.assign({{}}, base, {{
    weight: (base.weight != null ? base.weight : 1.5) + 2,
    color: '#3b82f6',
    dashArray: '4 3',
    fillOpacity: Math.min((base.fillOpacity != null ? base.fillOpacity : 0.35) + 0.1, 0.65),
  }});
}}

function clearHover() {{
  const key = hoveredFeatureKey;
  if (!key) return;
  hoveredFeatureKey = null;
  if (key === activeFeatureKey) return;
  const inst = featureLayerRefs[key];
  if (!inst) return;
  const parts = key.split(':');
  const li = Number(parts[0]);
  const fi = Number(parts[1]);
  const geojsonData = layerGeojsonData[li];
  const feat = geojsonData ? geojsonData.features[fi] : null;
  const gt = feat && feat.geometry ? feat.geometry.type : undefined;
  if ((gt === 'Point' || gt === 'MultiPoint') && typeof inst.setRadius === 'function') {{
    const lc = CONFIG.layers.find((l) => l.layerIndex === li);
    inst.setRadius((lc && lc.pointSize) || 5);
  }}
  const styleFn = layerStyleFns[li];
  if (!styleFn || typeof inst.setStyle !== 'function') return;
  const base = styleFn(inst.feature);
  const sameLayerAsActive = activeFeatureKey && activeFeatureKey.split(':')[0] === String(li);
  inst.setStyle(sameLayerAsActive ? getSubtleHighlightStyle(base) : base);
}}

function applyHover(key) {{
  if (key === hoveredFeatureKey) return;
  clearHover();
  if (!key || key === activeFeatureKey) return;
  const inst = featureLayerRefs[key];
  if (!inst) return;
  const parts = key.split(':');
  const li = Number(parts[0]);
  const fi = Number(parts[1]);
  const geojsonData = layerGeojsonData[li];
  const feat = geojsonData ? geojsonData.features[fi] : null;
  const gt = feat && feat.geometry ? feat.geometry.type : undefined;
  if ((gt === 'Point' || gt === 'MultiPoint') && typeof inst.setRadius === 'function') {{
    const lc = CONFIG.layers.find((l) => l.layerIndex === li);
    inst.setRadius(((lc && lc.pointSize) || 5) + 4);
  }}
  const styleFn = layerStyleFns[li];
  if (styleFn && typeof inst.setStyle === 'function') {{
    inst.setStyle(getPreviewHighlightStyle(styleFn(inst.feature)));
  }}
  hoveredFeatureKey = key;
}}

if (!(window.matchMedia && window.matchMedia('(hover: none)').matches && window.matchMedia('(pointer: coarse)').matches)) {{
  let hoverRaf = null;
  map.on('mousemove', (e) => {{
    if (hoverRaf !== null) return;
    hoverRaf = window.requestAnimationFrame(() => {{
      hoverRaf = null;
      try {{
        const top = getVisibleZOrderedFeatureCandidates(e.latlng)[0];
        applyHover(top ? top.layerIndex + ':' + top.featureIndex : null);
      }} catch (err) {{ /* abaikan error hit-test saat hover */ }}
    }});
  }});
  map.on('mouseout', () => {{
    if (hoverRaf !== null) {{ window.cancelAnimationFrame(hoverRaf); hoverRaf = null; }}
    clearHover();
  }});
}}

// Point/MultiPoint selalu tampak di atas Polygon/Buffer (murni z-order).
function bringPointFeaturesToFront() {{
  Object.keys(featureLayerRefs).forEach((key) => {{
    const parts = key.split(':');
    const layerIndex = Number(parts[0]);
    const featureIndex = Number(parts[1]);
    const geojsonData = layerGeojsonData[layerIndex];
    const feat = geojsonData ? geojsonData.features[featureIndex] : null;
    const geomType = feat && feat.geometry ? feat.geometry.type : undefined;
    if (geomType !== 'Point' && geomType !== 'MultiPoint') return;
    const layerInstance = featureLayerRefs[key];
    if (layerInstance && typeof layerInstance.bringToFront === 'function') {{
      layerInstance.bringToFront();
    }}
  }});
}}

// ---- Attribute Table: hanya layer dengan showAttributeTable=true yang
// muncul di dropdown, sesuai konfigurasi yang sudah diatur di GIS2Web
// Studio. Klik row -> selectFeature() (fungsi yang sama dipakai klik peta).
// Saat feature dipilih dari peta, tabel ikut sync (ganti layer dropdown +
// highlight row aktif). ----
const attrPanelEl = document.getElementById('attribute-table-panel');
const attrLayerSelectEl = document.getElementById('attribute-table-layer-select');
const attrCountEl = document.getElementById('attribute-table-count');
const attrToggleBtn = document.getElementById('attribute-table-toggle-btn');
const attrBodyEl = document.getElementById('attribute-table-body');
const attrDataTableEl = document.getElementById('attribute-data-table');

const attributeTableLayers = CONFIG.layers.filter((l) => l.showAttributeTable);
let attrSelectedLayerIndex = attributeTableLayers.length > 0 ? attributeTableLayers[0].layerIndex : null;
let attrCollapsed = true;

function renderAttributeTableOptions() {{
  attrLayerSelectEl.innerHTML = '';
  attributeTableLayers.forEach((l) => {{
    const opt = document.createElement('option');
    opt.value = String(l.layerIndex);
    opt.textContent = l.name;
    attrLayerSelectEl.appendChild(opt);
  }});
  if (attrSelectedLayerIndex !== null) {{
    attrLayerSelectEl.value = String(attrSelectedLayerIndex);
  }}
  attrLayerSelectEl.style.display = attributeTableLayers.length > 1 ? '' : 'none';
}}

function renderAttributeTableRows() {{
  if (attrSelectedLayerIndex === null) {{
    attrDataTableEl.innerHTML = '';
    attrCountEl.textContent = '';
    return;
  }}
  const geojsonData = layerGeojsonData[attrSelectedLayerIndex];
  if (!geojsonData) {{
    attrDataTableEl.innerHTML = '<tbody><tr><td>Memuat data...</td></tr></tbody>';
    return;
  }}
  const features = geojsonData.features || [];
  const fieldSet = [];
  features.forEach((f) => {{
    if (f.properties) {{
      Object.keys(f.properties).forEach((k) => {{
        if (fieldSet.indexOf(k) === -1) fieldSet.push(k);
      }});
    }}
  }});

  attrCountEl.textContent = features.length + ' fitur';

  if (fieldSet.length === 0) {{
    attrDataTableEl.innerHTML = '<tbody><tr><td>Tidak ada data atribut pada layer ini.</td></tr></tbody>';
    return;
  }}

  const theadHtml = '<thead><tr>' + fieldSet.map((f) => '<th>' + escapeHtml(f) + '</th>').join('') + '</tr></thead>';
  const tbodyRows = features.map((f, featureIndex) => {{
    const isActive = activeFeatureKey === (attrSelectedLayerIndex + ':' + featureIndex);
    const cells = fieldSet.map((field) => {{
      const v = f.properties ? f.properties[field] : undefined;
      return '<td>' + escapeHtml(v === null || v === undefined ? '-' : String(v)) + '</td>';
    }}).join('');
    return '<tr data-feature-index="' + featureIndex + '" class="' + (isActive ? 'active-row' : '') + '">' + cells + '</tr>';
  }}).join('');

  attrDataTableEl.innerHTML = theadHtml + '<tbody>' + tbodyRows + '</tbody>';

  const rows = attrDataTableEl.querySelectorAll('tbody tr');
  rows.forEach((tr) => {{
    tr.addEventListener('click', () => {{
      const fi = Number(tr.getAttribute('data-feature-index'));
      selectFeature(attrSelectedLayerIndex, fi);
    }});
  }});
}}

function setAttributeTableCollapsed(collapsed) {{
  attrCollapsed = collapsed;
  attrBodyEl.hidden = collapsed;
  attrToggleBtn.innerHTML = collapsed ? '&#9650;' : '&#9660;';
}}

attrToggleBtn.addEventListener('click', () => setAttributeTableCollapsed(!attrCollapsed));

attrLayerSelectEl.addEventListener('change', (e) => {{
  attrSelectedLayerIndex = Number(e.target.value);
  renderAttributeTableRows();
}});

function syncAttributeTableToActiveFeature() {{
  if (!activeFeatureKey) return;
  const layerIndex = Number(activeFeatureKey.split(':')[0]);
  const isTrackedLayer = attributeTableLayers.some((l) => l.layerIndex === layerIndex);
  if (!isTrackedLayer) return;

  if (attrSelectedLayerIndex !== layerIndex) {{
    attrSelectedLayerIndex = layerIndex;
    attrLayerSelectEl.value = String(layerIndex);
  }}
  renderAttributeTableRows();
}}

if (attributeTableLayers.length > 0) {{
  attrPanelEl.hidden = false;
  renderAttributeTableOptions();
  setAttributeTableCollapsed(true);
}}

// ---- Layer visibility toggle: on/off tampil di peta, murni interaksi
// end-user. TIDAK mengubah warna/opacity/order/konfigurasi lain - itu
// semua sudah final dari GIS2Web Studio dan tidak diedit di sini. ----
const layerTogglePanelEl = document.getElementById('layer-toggle-panel');
const layerToggleListEl = document.getElementById('layer-toggle-list');
const layerToggleCollapseBtn = document.getElementById('layer-toggle-collapse-btn');
let layerToggleCollapsed = false;

function setLayerToggleCollapsed(collapsed) {{
  layerToggleCollapsed = collapsed;
  layerToggleListEl.hidden = collapsed;
  layerToggleCollapseBtn.innerHTML = collapsed ? '&#9650;' : '&#9660;';
}}

layerToggleCollapseBtn.addEventListener('click', () => setLayerToggleCollapsed(!layerToggleCollapsed));

// ---- Legenda: menyatu dengan panel Layer. Warna memakai data yang sama
// dengan peta (categories / ranges), jadi selalu konsisten. ----
function legendKind(layerCfg) {{
  const g = String(layerCfg.geometryType || '').toLowerCase();
  if (g.indexOf('point') !== -1) return 'point';
  if (g.indexOf('line') !== -1) return 'line';
  return 'area';
}}

function legendFill(color, opacity) {{
  const m = /^#?([0-9a-f]{{6}})$/i.exec(color || '');
  if (!m) return color;
  const n = parseInt(m[1], 16);
  const a = Math.max(0.35, opacity == null ? 0.35 : opacity);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}}

function makeLegendSwatch(layerCfg, color) {{
  const s = document.createElement('i');
  const kind = layerCfg.isBoundary ? 'boundary' : legendKind(layerCfg);
  s.className = 'legend-swatch legend-swatch--' + kind;
  if (kind === 'boundary') {{
    s.style.borderColor = color;
  }} else if (kind === 'line') {{
    s.style.background = color;
  }} else {{
    s.style.background = legendFill(color, layerCfg.opacity);
    s.style.borderColor = color;
  }}
  return s;
}}

function buildLegendEntries(layerCfg) {{
  if (layerCfg.isBoundary) return null;
  let entries = null;
  if (layerCfg.categoryField && layerCfg.categories && layerCfg.categories.length > 0) {{
    entries = layerCfg.categories.map((c) => ({{ label: c.value === 'NULL' ? '(kosong)' : c.value, color: c.color }}));
  }} else if (layerCfg.categoryField && layerCfg.ranges && layerCfg.ranges.length > 0) {{
    entries = layerCfg.ranges.map((r) => ({{ label: r.label, color: r.color }}));
  }}
  if (!entries) return null;
  const wrap = document.createElement('div');
  wrap.className = 'legend-entries';
  entries.forEach((en) => {{
    const row = document.createElement('div');
    row.className = 'legend-entry';
    row.appendChild(makeLegendSwatch(layerCfg, en.color));
    const t = document.createElement('span');
    t.textContent = en.label;
    row.appendChild(t);
    wrap.appendChild(row);
  }});
  return wrap;
}}

function renderLayerTogglePanel() {{
  if (CONFIG.layers.length === 0) return;
  layerTogglePanelEl.hidden = false;
  layerToggleListEl.innerHTML = '';

  CONFIG.layers.forEach((layerCfg) => {{
    const gLayer = layerRefs[layerCfg.layerIndex];
    if (!gLayer) return;

    const item = document.createElement('label');
    item.className = 'layer-toggle-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = map.hasLayer(gLayer);
    checkbox.addEventListener('change', () => {{
      if (checkbox.checked) {{
        map.addLayer(gLayer);
      }} else {{
        map.removeLayer(gLayer);
        // Kalau feature yang sedang aktif ada di layer yang disembunyikan,
        // bersihkan seleksi supaya tidak ada popup/card 'menggantung' untuk
        // feature yang sudah tidak terlihat.
        if (activeFeatureKey && Number(activeFeatureKey.split(':')[0]) === layerCfg.layerIndex) {{
          activeFeatureKey = null;
          closeAllPopups();
          hideFeatureCard();
        }}
      }}
    }});

    const label = document.createElement('span');
    label.textContent = layerCfg.name + (layerCfg.isBoundary ? ' (Boundary)' : '');

    item.appendChild(checkbox);
    item.appendChild(label);

    const group = document.createElement('div');
    group.className = 'layer-toggle-group';
    group.appendChild(item);

    if (CONFIG.showLegend !== false) {{
      const legendEl = buildLegendEntries(layerCfg);
      if (legendEl) {{
        legendEl.hidden = !checkbox.checked;
        checkbox.addEventListener('change', () => {{ legendEl.hidden = !checkbox.checked; }});
        group.appendChild(legendEl);
      }} else {{
        item.insertBefore(makeLegendSwatch(layerCfg, layerCfg.color), label);
      }}
    }}
    layerToggleListEl.appendChild(group);
  }});
}}

// Meniru filter QGIS "$area = maximum($area, group_by:=...)": hanya 1
// feature per grup (yang luasnya paling besar) yang diberi label. Kalau
// layer tidak punya groupByField, semua feature yang bernilai dianggap
// berhak (labeling QGIS type="simple" tampil di semua feature).
function computeLabeledFeatureIndexes(layer, geojson) {{
  const result = new Set();
  if (!layer.labeling) return result;

  const groupByField = layer.labeling.groupByField;
  if (!groupByField) {{
    geojson.features.forEach((_, idx) => result.add(idx));
    return result;
  }}

  const largestByGroup = {{}};
  geojson.features.forEach((feature, idx) => {{
    const rawGroupValue = feature.properties ? feature.properties[groupByField] : undefined;
    const groupKey = rawGroupValue === null || rawGroupValue === undefined ? 'NULL' : String(rawGroupValue);

    let featureArea = 0;
    try {{
      featureArea = turf.area(feature);
    }} catch (e) {{
      featureArea = 0;
    }}

    const current = largestByGroup[groupKey];
    if (!current || featureArea > current.area) {{
      largestByGroup[groupKey] = {{ index: idx, area: featureArea }};
    }}
  }});

  Object.values(largestByGroup).forEach(({{ index }}) => result.add(index));
  return result;
}}

function loadLayer(layer) {{
  return fetch(layer.file)
    .then((res) => res.json())
    .then((geojson) => {{
      layerGeojsonData[layer.layerIndex] = geojson;

      const styleFn = (feature) => ({{
        color: resolveFeatureColor(layer, feature),
        weight: layer.isBoundary ? 2 : 1.5,
        fillOpacity: layer.isBoundary ? 0 : layer.opacity,
      }});
      layerStyleFns[layer.layerIndex] = styleFn;

      const labeledFeatureIndexes = computeLabeledFeatureIndexes(layer, geojson);

      const gLayer = L.geoJSON(geojson, {{
        style: styleFn,
        pointToLayer: (feature, latlng) =>
          L.circleMarker(latlng, {{
            radius: layer.pointSize || 5,
            color: resolveFeatureColor(layer, feature),
            fillOpacity: layer.opacity,
          }}),
        onEachFeature: (feature, layerInstance) => {{
          const featureIndex = geojson.features.indexOf(feature);
          const properties = feature.properties || null;


          if (!layer.isBoundary && featureIndex !== -1) {{
            featureLayerRefs[layer.layerIndex + ':' + featureIndex] = layerInstance;
          }}

          if (layer.labeling && featureIndex !== -1 && labeledFeatureIndexes.has(featureIndex)) {{
            const labelValue = properties ? properties[layer.labeling.field] : undefined;
            const labelText = labelValue === null || labelValue === undefined ? '' : String(labelValue);
            if (labelText) {{
              layerInstance.bindTooltip(escapeHtml(labelText), {{
                permanent: true,
                direction: 'center',
                className: 'layer-feature-label',
              }});
              layerInstance.once('tooltipopen', (e) => {{
                const savedPos = CONFIG.labelPositions && CONFIG.labelPositions[layer.layerIndex + ':' + featureIndex];
                if (savedPos) e.tooltip.setLatLng(L.latLng(savedPos[0], savedPos[1]));
                const tooltipEl = e.tooltip.getElement();
                if (tooltipEl) {{
                  tooltipEl.style.fontSize = (CONFIG.labelFontSize || 13) + 'px';
                }}
              }});
            }}
          }}
        }},
      }}).addTo(map);

      layerRefs[layer.layerIndex] = gLayer;

      if (layer.isBoundary) {{
        map.fitBounds(gLayer.getBounds());
        boundaryFitted = true;
      }} else if (!boundaryFitted) {{
        map.fitBounds(gLayer.getBounds());
      }}
    }})
    .catch((err) => console.error('Gagal memuat layer:', layer.file, err));
}}

Promise.all(CONFIG.layers.map(loadLayer)).then(() => {{
  // Urutan stacking final: CONFIG.layers[0] adalah layer paling atas (sesuai
  // urutan yang sudah diatur user di GIS2Web Studio / layerOrder). Sama
  // seperti applyStackingOrder di aplikasi: reverse dulu, lalu bringToFront
  // satu-satu, supaya elemen pertama di array yang menang paling atas.
  [...CONFIG.layers].reverse().forEach((layer) => {{
    const gLayer = layerRefs[layer.layerIndex];
    if (gLayer && typeof gLayer.bringToFront === 'function') {{
      gLayer.bringToFront();
    }}
  }});
  bringPointFeaturesToFront();
  if (attributeTableLayers.length > 0) {{
    renderAttributeTableRows();
  }}
  renderLayerTogglePanel();
}});
"#
    )
}

#[tauri::command]
fn export_web_gis(
    project_path: String,
    output_dir: String,
    layers: Vec<ExportLayerInput>,
    config: ExportConfig,
) -> Result<String, String> {
    let output_root = Path::new(&output_dir);
    let data_dir = output_root.join("data");
    let css_dir = output_root.join("css");
    let js_dir = output_root.join("js");

    std::fs::create_dir_all(&data_dir).map_err(|e| format!("Gagal membuat folder data: {e}"))?;
    std::fs::create_dir_all(&css_dir).map_err(|e| format!("Gagal membuat folder css: {e}"))?;
    std::fs::create_dir_all(&js_dir).map_err(|e| format!("Gagal membuat folder js: {e}"))?;

    let mut used_slugs: Vec<String> = Vec::new();
    let mut layer_entries: Vec<serde_json::Value> = Vec::new();

    for layer in &layers {
        let base_slug = slugify(&layer.name);
        let mut slug = base_slug.clone();
        let mut counter = 2;
        while used_slugs.contains(&slug) {
            slug = format!("{base_slug}_{counter}");
            counter += 1;
        }
        used_slugs.push(slug.clone());

        let file_name = format!("{slug}.geojson");
        let geojson_content = get_layer_geojson(project_path.clone(), layer.datasource.clone())?;

        std::fs::write(data_dir.join(&file_name), geojson_content)
            .map_err(|e| format!("Gagal menulis {file_name}: {e}"))?;

        let categories_json = layer.categories.as_ref().map(|cats| {
            cats.iter()
                .map(|c| serde_json::json!({ "value": c.value, "color": c.color }))
                .collect::<Vec<_>>()
        });

        let ranges_json = layer.ranges.as_ref().map(|ranges| {
            ranges
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "lower": r.lower,
                        "upper": r.upper,
                        "label": r.label,
                        "color": r.color,
                    })
                })
                .collect::<Vec<_>>()
        });

        let labeling_json = layer.labeling.as_ref().map(|l| {
            serde_json::json!({
                "field": l.field,
                "groupByField": l.group_by_field,
            })
        });

        layer_entries.push(serde_json::json!({
            "layerIndex": layer.layer_index,
            "file": format!("data/{file_name}"),
            "name": layer.name,
            "geometryType": layer.geometry_type,
            "color": layer.color,
            "opacity": layer.opacity,
            "pointSize": layer.point_size,
            "categoryField": layer.category_field,
            "categories": categories_json,
            "ranges": ranges_json,
            "labeling": labeling_json,
            "visibleFields": layer.visible_fields,
            "isBoundary": layer.is_boundary,
            "showAttributeTable": layer.show_attribute_table && !layer.is_boundary,
        }));
    }

    let config_json = serde_json::json!({
        "layers": layer_entries,
        "labelFontSize": config.label_font_size,
        "labelPositions": config.label_positions,
        "showLegend": config.show_legend.unwrap_or(true),
        "basemap": {
            "url": config.tile_url,
            "attribution": config.attribution,
        },
        "minZoom": config.min_zoom,
        "maxZoom": config.max_zoom,
    });

    let page_title = config
        .export_title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or("GIS2Web Studio Export");
    let mut index_html = build_index_html().replacen(
        "<title>GIS2Web Studio Export</title>",
        &format!("<title>{}</title>", escape_export_html(page_title)),
        1,
    );

    if let Some(png) = config.export_logo_png.as_deref().filter(|b| !b.is_empty()) {
        let assets_dir = output_root.join("assets");
        std::fs::create_dir_all(&assets_dir)
            .map_err(|e| format!("Gagal membuat folder assets: {e}"))?;
        std::fs::write(assets_dir.join("favicon.png"), png)
            .map_err(|e| format!("Gagal menulis favicon: {e}"))?;
        index_html = index_html.replacen(
            "<link rel=\"stylesheet\" href=\"css/style.css\" />",
            "<link rel=\"icon\" type=\"image/png\" href=\"assets/favicon.png\" />\n<link rel=\"stylesheet\" href=\"css/style.css\" />",
            1,
        );
    } else if let Some(logo_path) = config.export_logo_path.as_deref().filter(|p| !p.is_empty()) {
        let ext = Path::new(logo_path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();
        if !["png", "jpg", "jpeg", "svg", "ico"].contains(&ext.as_str()) {
            return Err("Format logo tidak didukung (gunakan PNG, JPG, SVG, atau ICO).".to_string());
        }
        let assets_dir = output_root.join("assets");
        std::fs::create_dir_all(&assets_dir)
            .map_err(|e| format!("Gagal membuat folder assets: {e}"))?;
        let icon_name = format!("favicon.{ext}");
        std::fs::copy(logo_path, assets_dir.join(&icon_name))
            .map_err(|e| format!("Gagal menyalin logo: {e}"))?;
        index_html = index_html.replacen(
            "<link rel=\"stylesheet\" href=\"css/style.css\" />",
            &format!(
                "<link rel=\"icon\" href=\"assets/{icon_name}\" />\n<link rel=\"stylesheet\" href=\"css/style.css\" />"
            ),
            1,
        );
    }

    std::fs::write(output_root.join("index.html"), index_html)
        .map_err(|e| format!("Gagal menulis index.html: {e}"))?;
    std::fs::write(css_dir.join("style.css"), build_style_css())
        .map_err(|e| format!("Gagal menulis style.css: {e}"))?;
    std::fs::write(js_dir.join("app.js"), build_app_js(&config_json.to_string()))
        .map_err(|e| format!("Gagal menulis app.js: {e}"))?;

    Ok(format!("Export berhasil ke: {output_dir}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            parse_qgis_project,
            parse_qgis_basemap_candidates,
            check_gdal_available,
            load_project_settings,
            save_project_settings,
            generate_tile_pyramid,
            get_layer_geojson,
            export_web_gis
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
