import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Home, FolderKanban, CheckSquare, AlertTriangle, CalendarDays, Repeat,
  LayoutTemplate, Package, UtensilsCrossed, Receipt, BarChart3, Settings,
  Users, LogOut, Plus, Search, Bell, ChevronDown, ChevronRight, Edit3,
  Trash2, Eye, Clock, FileText, Paperclip, X, ChevronLeft, Filter,
  MoreHorizontal, ArrowUpDown, Check, Circle, AlertCircle, Timer,
  TrendingUp, TrendingDown, Minus, ShoppingCart, Printer, Hash, ClipboardList
} from "lucide-react";

const generateId = () => Math.random().toString(36).substr(2, 9);
const now = new Date();
const fmt = (d) => d ? `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getFullYear()).toString().slice(-2)}` : '';
const fmtFull = (d) => d ? `${fmt(d)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}` : '';
const daysFromNow = (n) => new Date(now.getTime() + n * 86400000);

const INITIAL_EMPLOYEES = [];
const INITIAL_TEAMS = [];

const STATUS_OPTIONS = ["Not Started", "In Progress", "Report Issue", "Completed", "On Hold", "Pending Review"];
const STATUS_COLORS = {
  "Not Started": { bg: "#f1f5f9", text: "#64748b", dot: "#94a3b8" },
  "In Progress": { bg: "#dbeafe", text: "#1d4ed8", dot: "#3b82f6" },
  "Report Issue": { bg: "#fee2e2", text: "#dc2626", dot: "#ef4444" },
  "Completed": { bg: "#dcfce7", text: "#16a34a", dot: "#22c55e" },
  "On Hold": { bg: "#fef3c7", text: "#d97706", dot: "#f59e0b" },
  "Pending Review": { bg: "#ede9fe", text: "#7c3aed", dot: "#8b5cf6" },
  "Scheduled": { bg: "#e0f2fe", text: "#0284c7", dot: "#0ea5e9" },
  "Overdue": { bg: "#fee2e2", text: "#dc2626", dot: "#ef4444" },
  "Archived": { bg: "#f1f5f9", text: "#94a3b8", dot: "#cbd5e1" },
};
const PRIORITY_OPTIONS = ["Low", "Medium", "High", "Critical"];
const PROJECT_STATUS = ["Planned", "Active", "On Hold", "Completed", "Cancelled"];
const ISSUE_STATUS = ["Open", "In Progress", "Resolved", "Closed"];
const FREQUENCY_OPTIONS = ["Daily", "Weekly", "Monthly", "Annually", "Custom"];

const INITIAL_PROJECTS = [];
const INITIAL_TASKS = [];
const INITIAL_SUBTASKS = [];
const INITIAL_ISSUES = [];
const INITIAL_RECURRING = [];
const INITIAL_INVENTORY = [];

//  Utility Components 
const StatusBadge = ({ status }) => {
  const c = STATUS_COLORS[status] || STATUS_COLORS["Not Started"];
  return (
    <span style={{ background: c.bg, color: c.text, padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: c.dot, flexShrink: 0 }} />
      {status}
    </span>
  );
};

const PriorityBadge = ({ priority }) => {
  const colors = { Low: "#22c55e", Medium: "#f59e0b", High: "#ef4444", Critical: "#dc2626" };
  return (
    <span style={{ color: colors[priority] || "#64748b", fontWeight: 600, fontSize: 12 }}>
      {priority}
    </span>
  );
};

const StatCard = ({ icon: Icon, label, value, color, onClick }) => (
  <div onClick={onClick} style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "16px 20px", flex: 1, minWidth: 160, cursor: onClick ? "pointer" : "default", transition: "all 0.2s", display: "flex", alignItems: "center", gap: 14 }}
    onMouseEnter={e => { if(onClick) { e.currentTarget.style.borderColor = color; e.currentTarget.style.boxShadow = `0 2px 12px ${color}22`; }}}
    onMouseLeave={e => { e.currentTarget.style.borderColor = "#e2e8f0"; e.currentTarget.style.boxShadow = "none"; }}>
    <div style={{ width: 42, height: 42, borderRadius: 10, background: `${color}15`, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Icon size={20} color={color} />
    </div>
    <div>
      <div style={{ fontSize: 22, fontWeight: 700, color: "#0f172a", lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 12, color: "#64748b", fontWeight: 500 }}>{label}</div>
    </div>
  </div>
);

const DataTable = ({ columns, data, onRowClick, emptyMsg = "No data" }) => (
  <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden" }}>
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: "#f1f5f9" }}>
            {columns.map((col, i) => (
              <th key={i} style={{ padding: "10px 14px", textAlign: "left", fontWeight: 600, color: "#475569", fontSize: 12, borderBottom: "2px solid #e2e8f0", whiteSpace: "nowrap", ...(col.style || {}) }}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.length === 0 ? (
            <tr><td colSpan={columns.length} style={{ padding: 40, textAlign: "center", color: "#94a3b8" }}>
              <Package size={32} style={{ marginBottom: 8, opacity: 0.4 }} /><br/>{emptyMsg}
            </td></tr>
          ) : data.map((row, ri) => (
            <tr key={ri} onClick={() => onRowClick?.(row)} style={{ cursor: onRowClick ? "pointer" : "default", borderBottom: "1px solid #f1f5f9", transition: "background 0.15s" }}
              onMouseEnter={e => e.currentTarget.style.background = "#f8fafc"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              {columns.map((col, ci) => (
                <td key={ci} style={{ padding: "10px 14px", color: "#334155", whiteSpace: col.nowrap !== false ? "nowrap" : "normal", maxWidth: col.maxWidth || "none", overflow: "hidden", textOverflow: "ellipsis", ...(col.cellStyle || {}) }}>
                  {col.render ? col.render(row) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

const Modal = ({ open, onClose, title, width = 560, children }) => {
  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(15,23,42,0.45)", backdropFilter: "blur(4px)" }}
      onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 16, width: "90%", maxWidth: width, maxHeight: "90vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.2)", animation: "modalIn 0.2s ease-out" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 24px", borderBottom: "1px solid #e2e8f0" }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#0f172a" }}>{title}</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, borderRadius: 6, color: "#64748b" }}>
            <X size={18} />
          </button>
        </div>
        <div style={{ padding: 24, overflow: "auto", flex: 1 }}>{children}</div>
      </div>
    </div>
  );
};

const FormField = ({ label, children, required }) => (
  <div style={{ marginBottom: 14 }}>
    <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#475569", marginBottom: 5 }}>
      {label}{required && <span style={{ color: "#ef4444" }}> *</span>}
    </label>
    {children}
  </div>
);

const inputStyle = { width: "100%", padding: "8px 12px", border: "1.5px solid #d1d5db", borderRadius: 8, fontSize: 13, color: "#1e293b", outline: "none", background: "#fff", boxSizing: "border-box", transition: "border-color 0.2s" };
const btnPrimary = { background: "#0d9488", color: "#fff", border: "none", borderRadius: 8, padding: "9px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all 0.2s" };
const btnSecondary = { background: "#f1f5f9", color: "#475569", border: "1.5px solid #d1d5db", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 500, cursor: "pointer" };
const btnDanger = { ...btnPrimary, background: "#ef4444" };

const timeLeft = (dueDateStr) => {
  if (!dueDateStr) return "-";
  const parts = dueDateStr.split(" ");
  const dParts = parts[0].split("-");
  const d = new Date(2000 + parseInt(dParts[2]), parseInt(dParts[1]) - 1, parseInt(dParts[0]));
  if (parts[1]) { const [h, m] = parts[1].split(":"); d.setHours(parseInt(h), parseInt(m)); }
  const diff = d - now;
  if (diff < 0) return "Overdue";
  const days = Math.floor(diff / 86400000);
  if (days > 0) return `${days}d`;
  const hrs = Math.floor(diff / 3600000);
  return `${hrs}h`;
};

//  App Component 
export default function ERPTaskManager() {
  const [currentUser, setCurrentUser] = useState(null);
  const [employees, setEmployees] = useState(INITIAL_EMPLOYEES);
  const [teams, setTeams] = useState(INITIAL_TEAMS);
  const [tasks, setTasks] = useState(INITIAL_TASKS);
  const [subtasks, setSubtasks] = useState(INITIAL_SUBTASKS);
  const [projects, setProjects] = useState(INITIAL_PROJECTS);
  const [issues, setIssues] = useState(INITIAL_ISSUES);
  const [recurring, setRecurring] = useState(INITIAL_RECURRING);
  const [inventory, setInventory] = useState(INITIAL_INVENTORY);
  const [activePage, setActivePage] = useState("home");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [modalState, setModalState] = useState({ open: false, type: null, data: null });
  const [searchQuery, setSearchQuery] = useState("");

  const userRole = useMemo(() => {
    const emp = employees.find(e => e.name === currentUser);
    return emp?.role || "Employee";
  }, [currentUser, employees]);

  const isAdmin = userRole === "Admin" || userRole === "Manager";

  const visibleTasks = useMemo(() => {
    if (isAdmin) return tasks.filter(t => t.status !== "Archived");
    return tasks.filter(t => t.status !== "Archived" && (t.assignedTo === currentUser || t.assignedBy === currentUser));
  }, [tasks, currentUser, isAdmin]);

  const filteredTasks = useMemo(() => {
    if (!searchQuery) return visibleTasks;
    const q = searchQuery.toLowerCase();
    return visibleTasks.filter(t => t.name.toLowerCase().includes(q) || t.assignedTo.toLowerCase().includes(q) || t.status.toLowerCase().includes(q));
  }, [visibleTasks, searchQuery]);

  // Login
  if (!currentUser) {
    return <LoginPage employees={employees} onLogin={(name) => setCurrentUser(name)} />;
  }

  const navItems = [
    { key: "home", label: "Home", icon: Home },
    { key: "tasks", label: "Tasks", icon: CheckSquare },
    { key: "projects", label: "Projects", icon: FolderKanban },
    { key: "recurring", label: "Recurring", icon: Repeat },
    { key: "calendar", label: "Calendar", icon: CalendarDays },
    { key: "issues", label: "Issues", icon: AlertTriangle },
    { key: "templates", label: "Templates", icon: LayoutTemplate },
    { key: "inventory", label: "Inventory", icon: Package },
    { key: "reports", label: "Reports", icon: BarChart3 },
    ...(isAdmin ? [{ key: "employees", label: "Users", icon: Users }] : []),
    { key: "settings", label: "Settings", icon: Settings },
  ];

  const taskStats = {
    total: visibleTasks.length,
    inProgress: visibleTasks.filter(t => t.status === "In Progress").length,
    completed: visibleTasks.filter(t => t.status === "Completed").length,
    overdue: visibleTasks.filter(t => timeLeft(t.dueDate) === "Overdue" && t.status !== "Completed").length,
    pending: visibleTasks.filter(t => t.status === "Pending Review").length,
  };

  const openModal = (type, data = null) => setModalState({ open: true, type, data });
  const closeModal = () => setModalState({ open: false, type: null, data: null });

  const addTask = (task) => { setTasks(prev => [...prev, { ...task, id: `T${generateId()}` }]); closeModal(); };
  const updateTask = (id, updates) => { setTasks(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t)); closeModal(); };
  const deleteTask = (id) => { setTasks(prev => prev.filter(t => t.id !== id)); setSubtasks(prev => prev.filter(s => s.taskId !== id)); closeModal(); };

  const addProject = (project) => { setProjects(prev => [...prev, { ...project, id: `PRJ${generateId()}` }]); closeModal(); };
  const updateProject = (id, updates) => { setProjects(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p)); closeModal(); };

  const addIssue = (issue) => { setIssues(prev => [...prev, { ...issue, id: `ISS${generateId()}` }]); closeModal(); };
  const updateIssue = (id, updates) => { setIssues(prev => prev.map(i => i.id === id ? { ...i, ...updates } : i)); closeModal(); };

  const renderPage = () => {
    switch (activePage) {
      case "home": return <HomePage stats={taskStats} tasks={visibleTasks} projects={projects} issues={issues} onNavigate={setActivePage} currentUser={currentUser} isAdmin={isAdmin} />;
      case "tasks": return <TasksPage tasks={filteredTasks} subtasks={subtasks} employees={employees} projects={projects} searchQuery={searchQuery} onSearch={setSearchQuery} onAdd={() => openModal("addTask")} onEdit={(t) => openModal("editTask", t)} onDelete={deleteTask} onStatusChange={(id, s) => updateTask(id, { status: s })} isAdmin={isAdmin} currentUser={currentUser} />;
      case "projects": return <ProjectsPage projects={projects} tasks={tasks} employees={employees} teams={teams} onAdd={() => openModal("addProject")} onEdit={(p) => openModal("editProject", p)} isAdmin={isAdmin} currentUser={currentUser} />;
      case "recurring": return <RecurringPage recurring={recurring} employees={employees} onAdd={() => openModal("addRecurring")} />;
      case "calendar": return <CalendarPage tasks={tasks} recurring={recurring} />;
      case "issues": return <IssuesPage issues={issues} employees={employees} tasks={tasks} onAdd={() => openModal("addIssue")} onEdit={(i) => openModal("editIssue", i)} isAdmin={isAdmin} />;
      case "templates": return <TemplatesPage />;
      case "inventory": return <InventoryPage inventory={inventory} setInventory={setInventory} />;
      case "reports": return <ReportsPage tasks={tasks} projects={projects} issues={issues} employees={employees} />;
      case "employees": return <EmployeesPage employees={employees} setEmployees={setEmployees} teams={teams} setTeams={setTeams} />;
      case "settings": return <SettingsPage currentUser={currentUser} />;
      default: return <HomePage stats={taskStats} tasks={visibleTasks} projects={projects} issues={issues} onNavigate={setActivePage} currentUser={currentUser} isAdmin={isAdmin} />;
    }
  };

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif", background: "#f4f7fa", overflow: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap');
        @keyframes modalIn { from { opacity: 0; transform: scale(0.95) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideIn { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: translateX(0); } }
        * { box-sizing: border-box; scrollbar-width: thin; scrollbar-color: #cbd5e1 transparent; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
        ::-webkit-scrollbar-track { background: transparent; }
        input:focus, select:focus, textarea:focus { border-color: #0d9488 !important; box-shadow: 0 0 0 3px rgba(13,148,136,0.1) !important; }
        button:hover { opacity: 0.9; }
      `}</style>

      {/* Sidebar */}
      <div style={{ width: sidebarCollapsed ? 64 : 220, background: "#fff", borderRight: "1px solid #e2e8f0", display: "flex", flexDirection: "column", transition: "width 0.25s ease", flexShrink: 0, zIndex: 10 }}>
        <div style={{ padding: sidebarCollapsed ? "16px 12px" : "16px 20px", borderBottom: "1px solid #e2e8f0", display: "flex", alignItems: "center", gap: 10, minHeight: 60 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg, #0d9488, #14b8a6)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <CheckSquare size={16} color="#fff" />
          </div>
          {!sidebarCollapsed && <span style={{ fontWeight: 700, fontSize: 15, color: "#0f172a", letterSpacing: -0.3 }}>ERP Tasks</span>}
        </div>

        <nav style={{ flex: 1, padding: "8px 8px", overflowY: "auto" }}>
          {navItems.map(item => {
            const active = activePage === item.key;
            return (
              <button key={item.key} onClick={() => setActivePage(item.key)}
                style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: sidebarCollapsed ? "10px 0" : "9px 14px", marginBottom: 2, border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: active ? 600 : 500, color: active ? "#0d9488" : "#475569", background: active ? "#f0fdfa" : "transparent", transition: "all 0.15s", justifyContent: sidebarCollapsed ? "center" : "flex-start" }}
                onMouseEnter={e => { if(!active) e.currentTarget.style.background = "#f8fafc"; }}
                onMouseLeave={e => { if(!active) e.currentTarget.style.background = "transparent"; }}>
                <item.icon size={18} style={{ flexShrink: 0 }} />
                {!sidebarCollapsed && item.label}
              </button>
            );
          })}
        </nav>

        <div style={{ padding: "12px 8px", borderTop: "1px solid #e2e8f0" }}>
          <button onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", padding: "8px 0", border: "none", borderRadius: 8, cursor: "pointer", background: "#f8fafc", color: "#64748b", fontSize: 12 }}>
            {sidebarCollapsed ? <ChevronRight size={16} /> : <><ChevronLeft size={14} /> <span style={{ marginLeft: 6 }}>Collapse</span></>}
          </button>

          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 6px", marginTop: 8 }}>
            <div style={{ width: 32, height: 32, borderRadius: "50%", background: "#0d9488", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
              {currentUser.charAt(0)}
            </div>
            {!sidebarCollapsed && (
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentUser}</div>
                <div style={{ fontSize: 11, color: "#64748b" }}>{userRole}</div>
              </div>
            )}
            <button onClick={() => setCurrentUser(null)} title="Logout"
              style={{ background: "none", border: "none", cursor: "pointer", color: "#94a3b8", padding: 4, flexShrink: 0 }}>
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Top Bar */}
        <div style={{ background: "#fff", borderBottom: "1px solid #e2e8f0", padding: "0 24px", height: 56, display: "flex", alignItems: "center", gap: 16, flexShrink: 0 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#0f172a", letterSpacing: -0.3 }}>
            {navItems.find(n => n.key === activePage)?.label || "Dashboard"}
          </h2>
          <div style={{ flex: 1 }} />
          <div style={{ position: "relative" }}>
            <Bell size={18} color="#64748b" style={{ cursor: "pointer" }} />
            {taskStats.overdue > 0 && (
              <span style={{ position: "absolute", top: -4, right: -4, width: 16, height: 16, borderRadius: "50%", background: "#ef4444", color: "#fff", fontSize: 9, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>{taskStats.overdue}</span>
            )}
          </div>
          <div style={{ width: 1, height: 24, background: "#e2e8f0" }} />
          <div style={{ fontSize: 12, color: "#64748b" }}>{now.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric" })}</div>
        </div>

        {/* Page Content */}
        <div style={{ flex: 1, overflow: "auto", padding: 24, animation: "fadeIn 0.25s ease-out" }}>
          {renderPage()}
        </div>
      </div>

      {/* Modals */}
      <TaskModal open={modalState.open && (modalState.type === "addTask" || modalState.type === "editTask")} onClose={closeModal} task={modalState.data} employees={employees} projects={projects} onSave={modalState.type === "editTask" ? (data) => updateTask(modalState.data.id, data) : addTask} onDelete={modalState.type === "editTask" ? () => deleteTask(modalState.data.id) : null} currentUser={currentUser} />
      <ProjectModal open={modalState.open && (modalState.type === "addProject" || modalState.type === "editProject")} onClose={closeModal} project={modalState.data} employees={employees} teams={teams} onSave={modalState.type === "editProject" ? (data) => updateProject(modalState.data.id, data) : addProject} currentUser={currentUser} />
      <IssueModal open={modalState.open && (modalState.type === "addIssue" || modalState.type === "editIssue")} onClose={closeModal} issue={modalState.data} employees={employees} tasks={tasks} onSave={modalState.type === "editIssue" ? (data) => updateIssue(modalState.data.id, data) : addIssue} />
    </div>
  );
}

//  Login Page 
function LoginPage({ employees, onLogin }) {
  const [selected, setSelected] = useState(employees[0]?.name || "");
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(135deg, #f0fdfa 0%, #e0f2fe 50%, #ede9fe 100%)", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <div style={{ background: "#fff", borderRadius: 20, padding: "40px 36px", width: 380, boxShadow: "0 20px 60px rgba(0,0,0,0.08)", animation: "fadeIn 0.4s ease-out" }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ width: 56, height: 56, borderRadius: 14, background: "linear-gradient(135deg, #0d9488, #14b8a6)", display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
            <CheckSquare size={26} color="#fff" />
          </div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#0f172a" }}>Task Manager</h1>
          <p style={{ margin: "6px 0 0", color: "#64748b", fontSize: 14 }}>Sign in to continue</p>
        </div>
        <FormField label="Select User">
          <select value={selected} onChange={e => setSelected(e.target.value)} style={{ ...inputStyle, height: 40 }}>
            {employees.map(e => <option key={e.name} value={e.name}>{e.name}</option>)}
          </select>
        </FormField>
        <button onClick={() => onLogin(selected)} style={{ ...btnPrimary, width: "100%", padding: "12px 0", fontSize: 14, marginTop: 8 }}>Sign In</button>
      </div>
    </div>
  );
}

//  Home Page 
function HomePage({ stats, tasks, projects, issues, onNavigate, currentUser, isAdmin }) {
  const recentTasks = tasks.slice(0, 5);
  const greeting = now.getHours() < 12 ? "Good Morning" : now.getHours() < 17 ? "Good Afternoon" : "Good Evening";
  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "#0f172a" }}>{greeting}, {currentUser}!</h2>
        <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: 14 }}>Here's your dashboard overview</p>
      </div>

      <div style={{ display: "flex", gap: 14, marginBottom: 24, flexWrap: "wrap" }}>
        <StatCard icon={CheckSquare} label="Total Tasks" value={stats.total} color="#3b82f6" onClick={() => onNavigate("tasks")} />
        <StatCard icon={Clock} label="In Progress" value={stats.inProgress} color="#0d9488" />
        <StatCard icon={Check} label="Completed" value={stats.completed} color="#22c55e" />
        <StatCard icon={AlertCircle} label="Overdue" value={stats.overdue} color="#ef4444" />
        <StatCard icon={Timer} label="Pending Review" value={stats.pending} color="#8b5cf6" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Recent Tasks */}
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#0f172a" }}>Recent Tasks</h3>
            <button onClick={() => onNavigate("tasks")} style={{ ...btnSecondary, padding: "5px 12px", fontSize: 12 }}>View All</button>
          </div>
          {recentTasks.map(t => (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid #f1f5f9" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1e293b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</div>
                <div style={{ fontSize: 11, color: "#94a3b8" }}>{t.assignedTo} Â· Due: {t.dueDate?.split(" ")[0]}</div>
              </div>
              <StatusBadge status={t.status} />
            </div>
          ))}
        </div>

        {/* Projects & Issues Summary */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 20, flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#0f172a" }}>Projects</h3>
              <button onClick={() => onNavigate("projects")} style={{ ...btnSecondary, padding: "5px 12px", fontSize: 12 }}>View All</button>
            </div>
            {projects.slice(0, 3).map(p => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid #f1f5f9" }}>
                <FolderKanban size={16} color="#3b82f6" />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</div>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>{p.team} Â· {p.progress}% done</div>
                </div>
                <div style={{ width: 60, height: 6, borderRadius: 3, background: "#e2e8f0", overflow: "hidden" }}>
                  <div style={{ width: `${p.progress}%`, height: "100%", background: p.progress >= 80 ? "#22c55e" : "#3b82f6", borderRadius: 3, transition: "width 0.5s" }} />
                </div>
              </div>
            ))}
          </div>
          <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 20, flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#0f172a" }}>Open Issues</h3>
              <button onClick={() => onNavigate("issues")} style={{ ...btnSecondary, padding: "5px 12px", fontSize: 12 }}>View All</button>
            </div>
            {issues.filter(i => i.status === "Open" || i.status === "In Progress").slice(0, 3).map(i => (
              <div key={i.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid #f1f5f9" }}>
                <AlertTriangle size={15} color={i.priority === "High" ? "#ef4444" : "#f59e0b"} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{i.title}</div>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>{i.assignedTo} Â· <PriorityBadge priority={i.priority} /></div>
                </div>
              </div>
            ))}
            {issues.filter(i => i.status === "Open" || i.status === "In Progress").length === 0 && (
              <div style={{ textAlign: "center", color: "#94a3b8", fontSize: 13, padding: 16 }}>No open issues</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

//  Tasks Page 
function TasksPage({ tasks, subtasks, employees, projects, searchQuery, onSearch, onAdd, onEdit, onDelete, onStatusChange, isAdmin, currentUser }) {
  const [filterStatus, setFilterStatus] = useState("All");
  const filtered = filterStatus === "All" ? tasks : tasks.filter(t => t.status === filterStatus);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: 1, minWidth: 200, maxWidth: 340 }}>
          <Search size={16} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "#94a3b8" }} />
          <input value={searchQuery} onChange={e => onSearch(e.target.value)} placeholder="Search tasks..." style={{ ...inputStyle, paddingLeft: 36 }} />
        </div>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ ...inputStyle, width: "auto", minWidth: 140 }}>
          <option value="All">All Statuses</option>
          {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        {isAdmin && <button onClick={onAdd} style={btnPrimary}><Plus size={14} style={{ marginRight: 6 }} />New Task</button>}
      </div>

      <DataTable
        columns={[
          { label: "Task", key: "name", render: r => (
            <div>
              <div style={{ fontWeight: 600, color: "#0f172a" }}>{r.name}</div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{r.description?.slice(0, 50)}{r.description?.length > 50 ? "..." : ""}</div>
            </div>
          ), maxWidth: 280, nowrap: false },
          { label: "ID", key: "id", style: { width: 80 }, render: r => <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#64748b" }}>{r.id}</span> },
          { label: "Assigned To", key: "assignedTo" },
          { label: "Due Date", render: r => r.dueDate?.split(" ")[0] || "-" },
          { label: "Time Left", render: r => {
            const tl = timeLeft(r.dueDate);
            return <span style={{ color: tl === "Overdue" ? "#ef4444" : "#475569", fontWeight: tl === "Overdue" ? 700 : 500 }}>{tl}</span>;
          }},
          { label: "Status", render: r => <StatusBadge status={r.status} /> },
          { label: "Project", render: r => {
            const p = projects.find(p => p.id === r.projectId);
            return p ? <span style={{ fontSize: 12, color: "#3b82f6" }}>{p.name}</span> : <span style={{ color: "#cbd5e1" }}>â€”</span>;
          }},
          { label: "", style: { width: 40 }, render: r => (
            <button onClick={(e) => { e.stopPropagation(); onEdit(r); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#64748b", padding: 4 }}>
              <Edit3 size={14} />
            </button>
          )}
        ]}
        data={filtered}
        onRowClick={onEdit}
        emptyMsg="No tasks found"
      />
    </div>
  );
}

//  Projects Page 
function ProjectsPage({ projects, tasks, employees, teams, onAdd, onEdit, isAdmin, currentUser }) {
  const [view, setView] = useState("grid");
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <div style={{ flex: 1 }} />
        {isAdmin && <button onClick={onAdd} style={btnPrimary}><Plus size={14} style={{ marginRight: 6 }} />New Project</button>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320, 1fr))", gap: 16 }}>
        {projects.map(p => {
          const projectTasks = tasks.filter(t => t.projectId === p.id);
          const completedTasks = projectTasks.filter(t => t.status === "Completed").length;
          return (
            <div key={p.id} onClick={() => onEdit(p)} style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: 20, cursor: "pointer", transition: "all 0.2s" }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "#0d9488"; e.currentTarget.style.boxShadow = "0 4px 20px rgba(13,148,136,0.08)"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "#e2e8f0"; e.currentTarget.style.boxShadow = "none"; }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div>
                  <h4 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#0f172a" }}>{p.name}</h4>
                  <div style={{ fontSize: 12, color: "#64748b", marginTop: 3 }}>{p.team} Â· {p.owner}</div>
                </div>
                <StatusBadge status={p.status} />
              </div>
              <p style={{ margin: "0 0 14px", fontSize: 13, color: "#64748b", lineHeight: 1.5 }}>{p.description?.slice(0, 80)}{p.description?.length > 80 ? "..." : ""}</p>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <div style={{ flex: 1, height: 6, borderRadius: 3, background: "#e2e8f0", overflow: "hidden" }}>
                  <div style={{ width: `${p.progress}%`, height: "100%", background: p.progress >= 80 ? "#22c55e" : "#0d9488", borderRadius: 3, transition: "width 0.5s" }} />
                </div>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#0f172a" }}>{p.progress}%</span>
              </div>
              <div style={{ display: "flex", gap: 16, fontSize: 12, color: "#64748b" }}>
                <span><CheckSquare size={12} style={{ marginRight: 4 }} />{completedTasks}/{projectTasks.length} tasks</span>
                <span><PriorityBadge priority={p.priority} /></span>
              </div>
            </div>
          );
        })}
        {projects.length === 0 && (
          <div style={{ gridColumn: "1/-1", textAlign: "center", padding: 60, color: "#94a3b8" }}>
            <FolderKanban size={40} style={{ marginBottom: 12, opacity: 0.3 }} />
            <div>No projects yet</div>
          </div>
        )}
      </div>
    </div>
  );
}

//  Recurring Templates Page 
function RecurringPage({ recurring, employees, onAdd }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 20 }}>
        <button onClick={onAdd} style={btnPrimary}><Plus size={14} style={{ marginRight: 6 }} />New Template</button>
      </div>
      <DataTable
        columns={[
          { label: "Task Name", key: "taskName", render: r => <span style={{ fontWeight: 600 }}>{r.taskName}</span> },
          { label: "Assigned To", key: "assignedTo" },
          { label: "Frequency", key: "frequency", render: r => (
            <span style={{ background: "#f0fdfa", color: "#0d9488", padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600 }}>{r.frequency}</span>
          )},
          { label: "Next Run", key: "nextRun" },
          { label: "Duration", render: r => `${r.durationVal} ${r.durationUnit}` },
        ]}
        data={recurring}
        emptyMsg="No recurring templates"
      />
    </div>
  );
}

//  Calendar Page 
function CalendarPage({ tasks, recurring }) {
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();
  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  const tasksByDay = useMemo(() => {
    const map = {};
    tasks.forEach(t => {
      if (!t.dueDate) return;
      const parts = t.dueDate.split(" ")[0].split("-");
      const m = parseInt(parts[1]) - 1;
      const y = 2000 + parseInt(parts[2]);
      if (m === month && y === year) {
        const day = parseInt(parts[0]);
        if (!map[day]) map[day] = [];
        map[day].push({ name: t.name, color: "#3b82f6" });
      }
    });
    return map;
  }, [tasks, month, year]);

  const prevMonth = () => { if (month === 0) { setMonth(11); setYear(y => y-1); } else setMonth(m => m-1); };
  const nextMonth = () => { if (month === 11) { setMonth(0); setYear(y => y+1); } else setMonth(m => m+1); };

  return (
    <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <button onClick={prevMonth} style={btnSecondary}><ChevronLeft size={16} /> Prev</button>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{monthNames[month]} {year}</h3>
        <button onClick={nextMonth} style={btnSecondary}>Next <ChevronRight size={16} /></button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 1, background: "#e2e8f0", borderRadius: 8, overflow: "hidden" }}>
        {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d => (
          <div key={d} style={{ background: "#f1f5f9", padding: "10px 8px", textAlign: "center", fontSize: 12, fontWeight: 600, color: "#475569" }}>{d}</div>
        ))}
        {Array.from({ length: firstDay }).map((_, i) => <div key={`e${i}`} style={{ background: "#fafafa", padding: 8, minHeight: 80 }} />)}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1;
          const isToday = day === now.getDate() && month === now.getMonth() && year === now.getFullYear();
          const dayTasks = tasksByDay[day] || [];
          return (
            <div key={day} style={{ background: isToday ? "#f0fdfa" : "#fff", padding: 8, minHeight: 80, position: "relative" }}>
              <span style={{ fontSize: 12, fontWeight: isToday ? 700 : 400, color: isToday ? "#0d9488" : "#475569", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, borderRadius: "50%", background: isToday ? "#0d9488" : "transparent", ...(isToday ? { color: "#fff" } : {}) }}>{day}</span>
              {dayTasks.slice(0, 3).map((t, ti) => (
                <div key={ti} style={{ fontSize: 10, padding: "2px 4px", marginTop: 2, borderRadius: 3, background: `${t.color}15`, color: t.color, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</div>
              ))}
              {dayTasks.length > 3 && <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>+{dayTasks.length - 3} more</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

//  Issues Page 
function IssuesPage({ issues, employees, tasks, onAdd, onEdit, isAdmin }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 20 }}>
        <button onClick={onAdd} style={btnPrimary}><Plus size={14} style={{ marginRight: 6 }} />Report Issue</button>
      </div>
      <DataTable
        columns={[
          { label: "Issue", render: r => (
            <div>
              <div style={{ fontWeight: 600 }}>{r.title}</div>
              <div style={{ fontSize: 11, color: "#94a3b8" }}>{r.id}</div>
            </div>
          ), nowrap: false, maxWidth: 260 },
          { label: "Priority", render: r => <PriorityBadge priority={r.priority} /> },
          { label: "Status", render: r => <StatusBadge status={r.status} /> },
          { label: "Assigned To", key: "assignedTo" },
          { label: "Reported By", key: "reportedBy" },
          { label: "Date", key: "dateReported" },
          { label: "", style: { width: 40 }, render: r => (
            <button onClick={(e) => { e.stopPropagation(); onEdit(r); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#64748b", padding: 4 }}>
              <Edit3 size={14} />
            </button>
          )}
        ]}
        data={issues}
        onRowClick={onEdit}
        emptyMsg="No issues reported"
      />
    </div>
  );
}

//  Templates Page 
function TemplatesPage() {
  return (
    <div style={{ textAlign: "center", padding: 60, color: "#94a3b8" }}>
      <LayoutTemplate size={48} style={{ marginBottom: 16, opacity: 0.3 }} />
      <h3 style={{ color: "#64748b", fontWeight: 600 }}>Template Library</h3>
      <p style={{ fontSize: 14 }}>Create reusable task templates to speed up your workflow. Use the + button to add your first template.</p>
      <button style={btnPrimary}><Plus size={14} style={{ marginRight: 6 }} />Create Template</button>
    </div>
  );
}

//  Inventory Page 
function InventoryPage({ inventory, setInventory }) {
  const [showAdd, setShowAdd] = useState(false);
  const lowStock = inventory.filter(i => i.stock <= i.reorderLevel);

  return (
    <div>
      <div style={{ display: "flex", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
        <StatCard icon={Package} label="Total Items" value={inventory.length} color="#3b82f6" />
        <StatCard icon={AlertCircle} label="Low Stock" value={lowStock.length} color="#ef4444" />
        <StatCard icon={TrendingUp} label="Total Value" value={`â‚¹${inventory.reduce((s, i) => s + (i.stock * i.unitPrice), 0).toLocaleString()}`} color="#22c55e" />
      </div>

      <DataTable
        columns={[
          { label: "Item", render: r => <div><div style={{ fontWeight: 600 }}>{r.name}</div><div style={{ fontSize: 11, color: "#94a3b8" }}>{r.category}</div></div>, nowrap: false },
          { label: "ID", key: "id", render: r => <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#64748b" }}>{r.id}</span> },
          { label: "Stock", render: r => (
            <span style={{ fontWeight: 600, color: r.stock <= r.reorderLevel ? "#ef4444" : "#0f172a" }}>{r.stock} {r.unit}</span>
          )},
          { label: "Min", key: "minStock" },
          { label: "Reorder", key: "reorderLevel" },
          { label: "Unit Price", render: r => `â‚¹${r.unitPrice.toLocaleString()}` },
          { label: "Vendor", key: "vendor" },
          { label: "Value", render: r => `â‚¹${(r.stock * r.unitPrice).toLocaleString()}` },
        ]}
        data={inventory}
        emptyMsg="No inventory items"
      />
    </div>
  );
}

//  Reports Page 
function ReportsPage({ tasks, projects, issues, employees }) {
  const statusDist = STATUS_OPTIONS.map(s => ({ status: s, count: tasks.filter(t => t.status === s).length })).filter(s => s.count > 0);
  const totalTasks = tasks.length || 1;
  const empPerformance = employees.filter(e => e.role !== "Admin").map(e => ({
    name: e.name,
    total: tasks.filter(t => t.assignedTo === e.name).length,
    completed: tasks.filter(t => t.assignedTo === e.name && t.status === "Completed").length,
  }));

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Status Distribution */}
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 24 }}>
          <h3 style={{ margin: "0 0 20px", fontSize: 15, fontWeight: 700 }}>Task Status Distribution</h3>
          {statusDist.map(s => {
            const pct = Math.round((s.count / totalTasks) * 100);
            const c = STATUS_COLORS[s.status];
            return (
              <div key={s.status} style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                  <span style={{ fontWeight: 600, color: "#475569" }}>{s.status}</span>
                  <span style={{ color: "#64748b" }}>{s.count} ({pct}%)</span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: "#f1f5f9", overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: c.dot, borderRadius: 4, transition: "width 0.5s" }} />
                </div>
              </div>
            );
          })}
        </div>

        {/* Team Performance */}
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 24 }}>
          <h3 style={{ margin: "0 0 20px", fontSize: 15, fontWeight: 700 }}>Employee Performance</h3>
          {empPerformance.map(e => (
            <div key={e.name} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid #f1f5f9" }}>
              <div style={{ width: 32, height: 32, borderRadius: "50%", background: "#0d948815", color: "#0d9488", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 12, flexShrink: 0 }}>
                {e.name.charAt(0)}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{e.name}</div>
                <div style={{ fontSize: 11, color: "#94a3b8" }}>{e.completed}/{e.total} completed</div>
              </div>
              <div style={{ width: 60, height: 6, borderRadius: 3, background: "#e2e8f0", overflow: "hidden" }}>
                <div style={{ width: `${e.total ? (e.completed / e.total) * 100 : 0}%`, height: "100%", background: "#0d9488", borderRadius: 3 }} />
              </div>
            </div>
          ))}
        </div>

        {/* Summary Cards */}
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 24 }}>
          <h3 style={{ margin: "0 0 20px", fontSize: 15, fontWeight: 700 }}>Project Summary</h3>
          {projects.map(p => (
            <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #f1f5f9" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</div>
                <div style={{ fontSize: 11, color: "#94a3b8" }}>{p.status} Â· {p.priority}</div>
              </div>
              <span style={{ fontSize: 18, fontWeight: 700, color: "#0d9488" }}>{p.progress}%</span>
            </div>
          ))}
        </div>

        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 24 }}>
          <h3 style={{ margin: "0 0 20px", fontSize: 15, fontWeight: 700 }}>Issues Overview</h3>
          {[...new Set(issues.map(i => i.status))].map(status => {
            const count = issues.filter(i => i.status === status).length;
            return (
              <div key={status} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #f1f5f9" }}>
                <StatusBadge status={status} />
                <span style={{ fontSize: 18, fontWeight: 700, color: "#0f172a" }}>{count}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

//  Employees Page 
function EmployeesPage({ employees, setEmployees, teams, setTeams }) {
  const [showAdd, setShowAdd] = useState(false);
  const [newEmp, setNewEmp] = useState({ name: "", role: "Employee", team: "General" });

  const addEmployee = () => {
    if (!newEmp.name.trim()) return;
    setEmployees(prev => [...prev, { name: newEmp.name.trim(), role: newEmp.role, team: newEmp.team }]);
    setNewEmp({ name: "", role: "Employee", team: "General" });
    setShowAdd(false);
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginBottom: 20 }}>
        <button onClick={() => setShowAdd(true)} style={btnPrimary}><Plus size={14} style={{ marginRight: 6 }} />Add Employee</button>
      </div>

      <DataTable
        columns={[
          { label: "Employee", render: r => (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 32, height: 32, borderRadius: "50%", background: "#0d948815", color: "#0d9488", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, flexShrink: 0 }}>{r.name.charAt(0)}</div>
              <span style={{ fontWeight: 600 }}>{r.name}</span>
            </div>
          )},
          { label: "Role", render: r => (
            <span style={{ background: r.role === "Admin" ? "#fee2e2" : r.role === "Manager" ? "#dbeafe" : "#f1f5f9", color: r.role === "Admin" ? "#dc2626" : r.role === "Manager" ? "#1d4ed8" : "#475569", padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600 }}>{r.role}</span>
          )},
          { label: "Team", key: "team" },
        ]}
        data={employees}
        emptyMsg="No employees"
      />

      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add Employee">
        <FormField label="Name" required>
          <input value={newEmp.name} onChange={e => setNewEmp(p => ({ ...p, name: e.target.value }))} style={inputStyle} placeholder="Employee name" />
        </FormField>
        <FormField label="Role">
          <select value={newEmp.role} onChange={e => setNewEmp(p => ({ ...p, role: e.target.value }))} style={inputStyle}>
            {["Employee", "Manager", "Admin"].map(r => <option key={r}>{r}</option>)}
          </select>
        </FormField>
        <FormField label="Team">
          <select value={newEmp.team} onChange={e => setNewEmp(p => ({ ...p, team: e.target.value }))} style={inputStyle}>
            {teams.map(t => <option key={t}>{t}</option>)}
          </select>
        </FormField>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
          <button onClick={() => setShowAdd(false)} style={btnSecondary}>Cancel</button>
          <button onClick={addEmployee} style={btnPrimary}>Add Employee</button>
        </div>
      </Modal>
    </div>
  );
}

//  Settings Page 
function SettingsPage({ currentUser }) {
  return (
    <div style={{ maxWidth: 600 }}>
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 24, marginBottom: 20 }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 700 }}>General Settings</h3>
        <FormField label="Date Format">
          <select style={inputStyle} defaultValue="dd-mm-yy">
            <option value="dd-mm-yy">DD-MM-YY</option>
            <option value="mm-dd-yy">MM-DD-YY</option>
            <option value="yy-mm-dd">YY-MM-DD</option>
          </select>
        </FormField>
        <FormField label="Time Step (minutes)">
          <select style={inputStyle} defaultValue="5">
            <option value="5">5 minutes</option>
            <option value="10">10 minutes</option>
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
          </select>
        </FormField>
      </div>
      <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", padding: 24 }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 700 }}>Notifications</h3>
        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, cursor: "pointer", padding: "8px 0" }}>
          <input type="checkbox" defaultChecked style={{ width: 16, height: 16, accentColor: "#0d9488" }} />
          Enable task due reminders
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, cursor: "pointer", padding: "8px 0" }}>
          <input type="checkbox" defaultChecked style={{ width: 16, height: 16, accentColor: "#0d9488" }} />
          Email notifications for overdue tasks
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, cursor: "pointer", padding: "8px 0" }}>
          <input type="checkbox" style={{ width: 16, height: 16, accentColor: "#0d9488" }} />
          Desktop notification sounds
        </label>
      </div>
    </div>
  );
}

//  Task Modal 
function TaskModal({ open, onClose, task, employees, projects, onSave, onDelete, currentUser }) {
  const [form, setForm] = useState({});
  useEffect(() => {
    if (open) {
      setForm(task || { name: "", description: "", assignedTo: employees[0]?.name || "", assignedBy: currentUser, dateAssigned: fmtFull(now), durationVal: "1", durationUnit: "Days", dueDate: fmt(daysFromNow(7)), status: "Not Started", remarks: "", projectId: "" });
    }
  }, [open, task]);

  const handleSave = () => { if (!form.name?.trim()) return; onSave(form); };

  return (
    <Modal open={open} onClose={onClose} title={task ? `Edit Task â€” ${task.id}` : "New Task"} width={600}>
      <FormField label="Task Name" required>
        <input value={form.name || ""} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} style={inputStyle} />
      </FormField>
      <FormField label="Description">
        <textarea value={form.description || ""} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} style={{ ...inputStyle, minHeight: 60, resize: "vertical" }} />
      </FormField>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <FormField label="Assigned To">
          <select value={form.assignedTo || ""} onChange={e => setForm(p => ({ ...p, assignedTo: e.target.value }))} style={inputStyle}>
            {employees.map(e => <option key={e.name} value={e.name}>{e.name}</option>)}
          </select>
        </FormField>
        <FormField label="Status">
          <select value={form.status || "Not Started"} onChange={e => setForm(p => ({ ...p, status: e.target.value }))} style={inputStyle}>
            {STATUS_OPTIONS.map(s => <option key={s}>{s}</option>)}
          </select>
        </FormField>
        <FormField label="Due Date">
          <input type="date" value={form.dueDate?.split(" ")[0]?.split("-").reverse().join("-") || ""} onChange={e => { const d = e.target.value.split("-"); setForm(p => ({ ...p, dueDate: `${d[2]}-${d[1]}-${d[0].slice(-2)}` })); }} style={inputStyle} />
        </FormField>
        <FormField label="Project">
          <select value={form.projectId || ""} onChange={e => setForm(p => ({ ...p, projectId: e.target.value }))} style={inputStyle}>
            <option value="">No Project</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </FormField>
        <FormField label="Duration">
          <div style={{ display: "flex", gap: 8 }}>
            <input type="number" value={form.durationVal || "1"} onChange={e => setForm(p => ({ ...p, durationVal: e.target.value }))} style={{ ...inputStyle, width: 80 }} min="1" />
            <select value={form.durationUnit || "Days"} onChange={e => setForm(p => ({ ...p, durationUnit: e.target.value }))} style={{ ...inputStyle, flex: 1 }}>
              <option>Hours</option><option>Days</option><option>Weeks</option>
            </select>
          </div>
        </FormField>
      </div>
      <FormField label="Remarks">
        <textarea value={form.remarks || ""} onChange={e => setForm(p => ({ ...p, remarks: e.target.value }))} style={{ ...inputStyle, minHeight: 50, resize: "vertical" }} />
      </FormField>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
        {onDelete && <button onClick={onDelete} style={{ ...btnDanger, marginRight: "auto" }}><Trash2 size={14} style={{ marginRight: 6 }} />Delete</button>}
        <button onClick={onClose} style={btnSecondary}>Cancel</button>
        <button onClick={handleSave} style={btnPrimary}>{task ? "Update" : "Create"} Task</button>
      </div>
    </Modal>
  );
}

//  Project Modal 
function ProjectModal({ open, onClose, project, employees, teams, onSave, currentUser }) {
  const [form, setForm] = useState({});
  useEffect(() => {
    if (open) {
      setForm(project || { name: "", description: "", team: teams[0] || "General", owner: employees[0]?.name || "", status: "Planned", priority: "Medium", start: fmt(now), due: fmt(daysFromNow(30)), progress: 0, createdBy: currentUser, createdOn: fmtFull(now) });
    }
  }, [open, project]);

  return (
    <Modal open={open} onClose={onClose} title={project ? `Edit Project â€” ${project.id}` : "New Project"} width={580}>
      <FormField label="Project Name" required>
        <input value={form.name || ""} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} style={inputStyle} />
      </FormField>
      <FormField label="Description">
        <textarea value={form.description || ""} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} style={{ ...inputStyle, minHeight: 60, resize: "vertical" }} />
      </FormField>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <FormField label="Team">
          <select value={form.team || ""} onChange={e => setForm(p => ({ ...p, team: e.target.value }))} style={inputStyle}>
            {teams.map(t => <option key={t}>{t}</option>)}
          </select>
        </FormField>
        <FormField label="Owner">
          <select value={form.owner || ""} onChange={e => setForm(p => ({ ...p, owner: e.target.value }))} style={inputStyle}>
            {employees.map(e => <option key={e.name} value={e.name}>{e.name}</option>)}
          </select>
        </FormField>
        <FormField label="Status">
          <select value={form.status || "Planned"} onChange={e => setForm(p => ({ ...p, status: e.target.value }))} style={inputStyle}>
            {PROJECT_STATUS.map(s => <option key={s}>{s}</option>)}
          </select>
        </FormField>
        <FormField label="Priority">
          <select value={form.priority || "Medium"} onChange={e => setForm(p => ({ ...p, priority: e.target.value }))} style={inputStyle}>
            {PRIORITY_OPTIONS.map(p => <option key={p}>{p}</option>)}
          </select>
        </FormField>
        <FormField label="Progress (%)">
          <input type="number" value={form.progress || 0} onChange={e => setForm(p => ({ ...p, progress: parseInt(e.target.value) || 0 }))} style={inputStyle} min="0" max="100" />
        </FormField>
      </div>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
        <button onClick={onClose} style={btnSecondary}>Cancel</button>
        <button onClick={() => { if (form.name?.trim()) onSave(form); }} style={btnPrimary}>{project ? "Update" : "Create"} Project</button>
      </div>
    </Modal>
  );
}

//  Issue Modal 
function IssueModal({ open, onClose, issue, employees, tasks, onSave }) {
  const [form, setForm] = useState({});
  useEffect(() => {
    if (open) {
      setForm(issue || { title: "", description: "", taskId: "", reportedBy: employees[0]?.name || "", assignedTo: employees[0]?.name || "", priority: "Medium", status: "Open", dateReported: fmtFull(now), remarks: "" });
    }
  }, [open, issue]);

  return (
    <Modal open={open} onClose={onClose} title={issue ? `Edit Issue â€” ${issue.id}` : "Report Issue"} width={560}>
      <FormField label="Title" required>
        <input value={form.title || ""} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} style={inputStyle} />
      </FormField>
      <FormField label="Description">
        <textarea value={form.description || ""} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} style={{ ...inputStyle, minHeight: 60, resize: "vertical" }} />
      </FormField>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <FormField label="Priority">
          <select value={form.priority || "Medium"} onChange={e => setForm(p => ({ ...p, priority: e.target.value }))} style={inputStyle}>
            {PRIORITY_OPTIONS.map(p => <option key={p}>{p}</option>)}
          </select>
        </FormField>
        <FormField label="Status">
          <select value={form.status || "Open"} onChange={e => setForm(p => ({ ...p, status: e.target.value }))} style={inputStyle}>
            {ISSUE_STATUS.map(s => <option key={s}>{s}</option>)}
          </select>
        </FormField>
        <FormField label="Assigned To">
          <select value={form.assignedTo || ""} onChange={e => setForm(p => ({ ...p, assignedTo: e.target.value }))} style={inputStyle}>
            {employees.map(e => <option key={e.name} value={e.name}>{e.name}</option>)}
          </select>
        </FormField>
        <FormField label="Related Task">
          <select value={form.taskId || ""} onChange={e => setForm(p => ({ ...p, taskId: e.target.value }))} style={inputStyle}>
            <option value="">None</option>
            {tasks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </FormField>
      </div>
      <FormField label="Remarks">
        <textarea value={form.remarks || ""} onChange={e => setForm(p => ({ ...p, remarks: e.target.value }))} style={{ ...inputStyle, minHeight: 50, resize: "vertical" }} />
      </FormField>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
        <button onClick={onClose} style={btnSecondary}>Cancel</button>
        <button onClick={() => { if (form.title?.trim()) onSave(form); }} style={btnPrimary}>{issue ? "Update" : "Submit"} Issue</button>
      </div>
    </Modal>
  );
}

