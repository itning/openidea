//! IDEA-compatible Git Log state, stored in `<project>/.openidea/workspace.xml`.
//!
//! IDEA keeps the Log tab's filters in `workspace.xml`:
//! `Vcs.Log.Tabs.Properties` → `TAB_STATES` → `FILTERS` → `branch`, where the
//! branch filter is a list of refs (`main`, `origin/elasticsearch`, `HEAD`).
//! The openidea log follows the selected repository, so every repository has
//! its own `TAB_STATES` entry (keyed by `$PROJECT_DIR$` or a path below it).

use ide_core::{IdeError, IdeResult};
use quick_xml::events::{BytesDecl, BytesEnd, BytesStart, BytesText, Event};
use quick_xml::{Reader, Writer, XmlVersion};
use std::collections::BTreeMap;
use std::path::Path;

pub const FILE: &str = "workspace.xml";

const COMPONENT: &str = "Vcs.Log.Tabs.Properties";

/// The remembered branch filters of every repository, by repository key.
pub fn load_branch_filters(project_root: &Path) -> IdeResult<BTreeMap<String, Vec<String>>> {
    let path = ide_core::project_dir::path(project_root, FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(e) => return Err(e.into()),
    };
    if text.trim().is_empty() {
        return Ok(BTreeMap::new());
    }
    Ok(branch_filters(&parse(&text)?))
}

/// Sets one repository's remembered branch filter. An empty list means all branches.
pub fn save_branch_filter(project_root: &Path, repo: &str, branches: &[String]) -> IdeResult<()> {
    let path = ide_core::project_dir::path(project_root, FILE);
    let mut doc = match std::fs::read_to_string(&path) {
        Ok(text) if !text.trim().is_empty() => parse(&text)?,
        Ok(_) => new_project(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => new_project(),
        Err(e) => return Err(e.into()),
    };
    if doc.name != "project" {
        return Err(IdeError::invalid("workspace.xml: the root element is not <project>"));
    }

    let component = doc.ensure_with_attr("component", "name", COMPONENT);
    let tab_states = component.ensure_with_attr("option", "name", "TAB_STATES");
    let map = tab_states.ensure("map");
    let entry = map.ensure_with_attr("entry", "key", repo);
    let value = entry.ensure("value");
    let state = value.ensure("State");
    let filters = state.ensure_with_attr("option", "name", "FILTERS");
    let filters_map = filters.ensure("map");
    let branch_entry = filters_map.ensure_with_attr("entry", "key", "branch");
    let branch_value = branch_entry.ensure("value");
    let list = branch_value.ensure("list");
    list.children.clear();
    for branch in branches {
        let mut option = Node::new("option");
        option.set_attr("value", branch);
        list.children.push(option);
    }

    write_atomic(&path, &doc)
}

fn new_project() -> Node {
    let mut project = Node::new("project");
    project.set_attr("version", "4");
    project
}

/// The `branch` filter list of every `TAB_STATES` entry. An entry without one shows all branches.
fn branch_filters(doc: &Node) -> BTreeMap<String, Vec<String>> {
    let mut out = BTreeMap::new();
    let Some(component) = doc.child_with_attr("component", "name", COMPONENT) else {
        return out;
    };
    let Some(tab_states) = component.child_with_attr("option", "name", "TAB_STATES") else {
        return out;
    };
    let Some(map) = tab_states.child("map") else {
        return out;
    };
    for entry in map.children.iter().filter(|n| n.name == "entry") {
        if let Some(key) = entry.attr("key") {
            out.insert(key.to_string(), branch_list(entry));
        }
    }
    out
}

fn branch_list(entry: &Node) -> Vec<String> {
    let list = entry
        .child("value")
        .and_then(|v| v.child("State"))
        .and_then(|s| s.child_with_attr("option", "name", "FILTERS"))
        .and_then(|o| o.child("map"))
        .and_then(|m| m.child_with_attr("entry", "key", "branch"))
        .and_then(|e| e.child("value"))
        .and_then(|v| v.child("list"));
    let Some(list) = list else {
        return Vec::new();
    };
    list.children.iter().filter(|n| n.name == "option").filter_map(|n| n.attr("value").map(str::to_string)).collect()
}

// --- a minimal XML document tree (enough for workspace.xml) -----------------

#[derive(Debug, Default)]
struct Node {
    name: String,
    attrs: Vec<(String, String)>,
    children: Vec<Node>,
}

impl Node {
    fn new(name: &str) -> Self {
        Self { name: name.to_string(), attrs: Vec::new(), children: Vec::new() }
    }

    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    fn set_attr(&mut self, name: &str, value: &str) {
        match self.attrs.iter_mut().find(|(k, _)| k == name) {
            Some((_, v)) => *v = value.to_string(),
            None => self.attrs.push((name.to_string(), value.to_string())),
        }
    }

    fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|n| n.name == name)
    }

    fn child_with_attr(&self, name: &str, key: &str, value: &str) -> Option<&Node> {
        self.children.iter().find(|n| n.name == name && n.attr(key) == Some(value))
    }

    /// The child `name`, created when missing.
    fn ensure(&mut self, name: &str) -> &mut Node {
        match self.children.iter().position(|n| n.name == name) {
            Some(i) => &mut self.children[i],
            None => {
                self.children.push(Node::new(name));
                self.children.last_mut().unwrap()
            }
        }
    }

    /// The child `name` whose `key` attribute is `value`, created when missing.
    fn ensure_with_attr(&mut self, name: &str, key: &str, value: &str) -> &mut Node {
        match self.children.iter().position(|n| n.name == name && n.attr(key) == Some(value)) {
            Some(i) => &mut self.children[i],
            None => {
                let mut node = Node::new(name);
                node.set_attr(key, value);
                self.children.push(node);
                self.children.last_mut().unwrap()
            }
        }
    }
}

fn parse(text: &str) -> IdeResult<Node> {
    let mut reader = Reader::from_str(text);
    let mut stack: Vec<Node> = Vec::new();
    let mut root: Option<Node> = None;
    loop {
        match reader.read_event().map_err(xml_error)? {
            Event::Start(e) => stack.push(node_from(&e)?),
            Event::Empty(e) => {
                let node = node_from(&e)?;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(node),
                    None => root = Some(node),
                }
            }
            Event::End(_) => {
                let node = stack.pop().ok_or_else(|| IdeError::invalid("workspace.xml: unbalanced element"))?;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(node),
                    None => root = Some(node),
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !stack.is_empty() {
        return Err(IdeError::invalid("workspace.xml: unterminated element"));
    }
    root.ok_or_else(|| IdeError::invalid("workspace.xml: empty document"))
}

fn node_from(e: &BytesStart) -> IdeResult<Node> {
    let name = e.name().as_ref().to_string();
    let mut attrs = Vec::new();
    for attr in e.attributes() {
        let attr = attr.map_err(xml_error)?;
        let key = attr.key.as_ref().to_string();
        let value = attr.normalized_value(XmlVersion::Implicit1_0).map_err(xml_error)?.into_owned();
        attrs.push((key, value));
    }
    Ok(Node { name, attrs, children: Vec::new() })
}

fn write_atomic(file: &Path, doc: &Node) -> IdeResult<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut writer = Writer::new_with_indent(Vec::new(), b' ', 2);
    writer.write_event(Event::Decl(BytesDecl::new("1.0", Some("UTF-8"), None))).map_err(xml_error)?;
    writer.write_event(Event::Text(BytesText::new("\n"))).map_err(xml_error)?;
    write_node(&mut writer, doc)?;
    writer.write_event(Event::Text(BytesText::new("\n"))).map_err(xml_error)?;

    let tmp = file.with_extension("xml.tmp");
    std::fs::write(&tmp, writer.into_inner())?;
    std::fs::rename(&tmp, file)?;
    Ok(())
}

fn write_node(writer: &mut Writer<Vec<u8>>, node: &Node) -> IdeResult<()> {
    let mut start = BytesStart::new(node.name.as_str());
    for (key, value) in &node.attrs {
        start.push_attribute((key.as_str(), value.as_str()));
    }
    if node.children.is_empty() {
        writer.write_event(Event::Empty(start)).map_err(xml_error)?;
    } else {
        writer.write_event(Event::Start(start)).map_err(xml_error)?;
        for child in &node.children {
            write_node(writer, child)?;
        }
        writer.write_event(Event::End(BytesEnd::new(node.name.as_str()))).map_err(xml_error)?;
    }
    Ok(())
}

fn xml_error(e: impl std::fmt::Display) -> IdeError {
    IdeError::invalid(format!("workspace.xml: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn file(root: &Path) -> std::path::PathBuf {
        ide_core::project_dir::path(root, FILE)
    }

    fn write_workspace(root: &Path, xml: &str) {
        fs::create_dir_all(ide_core::project_dir::path(root, "")).unwrap();
        fs::write(file(root), xml).unwrap();
    }

    #[test]
    fn a_project_without_a_workspace_file_has_no_branch_filters() {
        let dir = tempdir().unwrap();
        assert!(load_branch_filters(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn an_empty_workspace_file_is_treated_as_empty() {
        let dir = tempdir().unwrap();
        write_workspace(dir.path(), "");
        assert!(load_branch_filters(dir.path()).unwrap().is_empty());

        save_branch_filter(dir.path(), "$PROJECT_DIR$", &["main".into()]).unwrap();
        assert_eq!(load_branch_filters(dir.path()).unwrap()["$PROJECT_DIR$"], ["main"]);
    }

    #[test]
    fn branch_filters_are_stored_per_repository_in_the_idea_layout() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        save_branch_filter(root, "$PROJECT_DIR$", &["main".into(), "origin/elasticsearch".into()]).unwrap();
        save_branch_filter(root, "$PROJECT_DIR$/backend", &["dev".into()]).unwrap();

        let filters = load_branch_filters(root).unwrap();
        assert_eq!(filters["$PROJECT_DIR$"], ["main", "origin/elasticsearch"]);
        assert_eq!(filters["$PROJECT_DIR$/backend"], ["dev"]);

        let xml = fs::read_to_string(file(root)).unwrap();
        assert!(xml.contains(r#"<component name="Vcs.Log.Tabs.Properties">"#));
        assert!(xml.contains(r#"<option name="TAB_STATES">"#));
        assert!(xml.contains(r#"<entry key="$PROJECT_DIR$">"#));
        assert!(xml.contains(r#"<option name="FILTERS">"#));
        assert!(xml.contains(r#"<entry key="branch">"#));
        assert!(xml.contains(r#"<option value="origin/elasticsearch""#));
    }

    #[test]
    fn an_empty_list_means_all_branches() {
        let dir = tempdir().unwrap();
        save_branch_filter(dir.path(), "$PROJECT_DIR$", &[]).unwrap();
        assert!(load_branch_filters(dir.path()).unwrap()["$PROJECT_DIR$"].is_empty());
    }

    #[test]
    fn saving_replaces_the_repository_list_and_keeps_the_others() {
        let dir = tempdir().unwrap();
        save_branch_filter(dir.path(), "$PROJECT_DIR$", &["main".into()]).unwrap();
        save_branch_filter(dir.path(), "$PROJECT_DIR$/backend", &["dev".into()]).unwrap();
        save_branch_filter(dir.path(), "$PROJECT_DIR$", &["feature/x".into()]).unwrap();

        let filters = load_branch_filters(dir.path()).unwrap();
        assert_eq!(filters["$PROJECT_DIR$"], ["feature/x"]);
        assert_eq!(filters["$PROJECT_DIR$/backend"], ["dev"]);
    }

    #[test]
    fn other_workspace_state_is_preserved() {
        let dir = tempdir().unwrap();
        write_workspace(
            dir.path(),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="Other">
    <option name="keep" value="yes" />
  </component>
</project>
"#,
        );
        save_branch_filter(dir.path(), "$PROJECT_DIR$", &["main".into()]).unwrap();

        let xml = fs::read_to_string(file(dir.path())).unwrap();
        assert!(xml.contains(r#"<component name="Other">"#));
        assert!(xml.contains(r#"<option name="keep" value="yes""#));
        assert_eq!(load_branch_filters(dir.path()).unwrap()["$PROJECT_DIR$"], ["main"]);
    }

    #[test]
    fn special_characters_round_trip() {
        let dir = tempdir().unwrap();
        save_branch_filter(dir.path(), "$PROJECT_DIR$/a&b", &["feat/a&b".into()]).unwrap();
        assert_eq!(load_branch_filters(dir.path()).unwrap()["$PROJECT_DIR$/a&b"], ["feat/a&b"]);
    }

    #[test]
    fn malformed_xml_is_reported() {
        let dir = tempdir().unwrap();
        write_workspace(dir.path(), "<project");
        assert!(load_branch_filters(dir.path()).is_err());
    }
}
