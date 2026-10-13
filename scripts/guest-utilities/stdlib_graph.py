"""Bounded build-only import graph over captured bytes. Never import those bytes."""
import ast
import hashlib
import json
import re

PREFIX = '/usr/lib/python3.12/'
SEEDS = ('multiprocessing.shared_memory', 'multiprocessing.synchronize',
         'multiprocessing.resource_tracker', 'multiprocessing.spawn',
         'multiprocessing.popen_fork')
MAX_SOURCE = 1024 * 1024
MAX_MODULES = 2048
MAX_IMPORTS = 20000


def digest(data):
    return hashlib.sha256(data).hexdigest()


def payload_roots(smoke, descendant):
    """Accept the fixed fixture's literal single-quoted -c / PY heredoc grammar."""
    if len(smoke) > MAX_SOURCE or len(descendant) > MAX_SOURCE:
        raise ValueError('static Python payload limit')
    text = smoke.decode('utf-8')
    pattern = r"(?m)^python3[ \t]+(?:-c[ \t]+'([^']*)'|-[ \t]+<<'PY'\n(.*?)\nPY(?=\n|$))"
    matches = list(re.finditer(pattern, text, re.S))
    if not matches or {match.start() for match in matches} != {match.start() for match in re.finditer(r'(?m)^python3\b', text)}:
        raise ValueError('all Python payloads must use the fixed literal grammar')
    roots = [(f'smoke:{index + 1}', (match.group(1) if match.group(1) is not None else match.group(2)).encode()) for index, match in enumerate(matches)]
    return roots + [('descendant', descendant)]


def validate(files, read_source, roots, builtin_names, builder_identity, seeds=SEEDS, interpreter_platform=None):
    """Required module-body graph only; optional/lazy observations prove no closure."""
    interpreter = files.get('/usr/bin/python3', {})
    if type(builder_identity) is not dict or set(builder_identity) != {'version','sha256','bytes'} or type(builder_identity['bytes']) is not int or type(builder_identity['version']) is not str or type(builder_identity['sha256']) is not str or not re.fullmatch('[a-f0-9]{64}', builder_identity['sha256']):
        raise ValueError('closed measured builder identity required')
    if interpreter.get('role') != 'executable' or interpreter.get('source') != 'usr/bin/python3.12' or any(builder_identity.get(key) != interpreter.get(key) for key in ('sha256', 'bytes')):
        raise ValueError('builtin inventory requires exact captured interpreter identity')
    if not builder_identity.get('version', '').startswith('3.12.'):
        raise ValueError('fixed Python 3.12 builtin inventory required')
    if interpreter_platform != 'linux':
        raise ValueError('fixed Linux interpreter platform required')
    if type(builtin_names) not in (tuple, list) or not 1 <= len(builtin_names) <= 512 or any(type(name) is not str or not re.fullmatch(r'[A-Za-z_]\w*', name, re.ASCII) for name in builtin_names) or len(set(builtin_names)) != len(builtin_names):
        raise ValueError('bounded interpreter builtin names required')
    builtins = set(builtin_names)
    modules = {}
    for guest, item in files.items():
        if item['role'] == 'stdlib':
            if not guest.startswith(PREFIX) or not guest.endswith('.py'):
                raise ValueError('captured pure module path')
            relative = guest[len(PREFIX):-3]
            package = relative.endswith('/__init__')
            name = (relative[:-9] if package else relative).replace('/', '.')
        elif item['role'] == 'extension':
            match = re.fullmatch(re.escape(PREFIX) + r'lib-dynload/([A-Za-z_]\w*)\.(?:cpython-312-aarch64-linux-gnu|abi3)\.so', guest, re.ASCII)
            if not match:
                raise ValueError('fixed captured extension spelling')
            name = match.group(1);package = False
        else:
            continue
        if name in modules or not re.fullmatch(r'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*', name, re.ASCII):
            raise ValueError('ambiguous captured module inventory')
        modules[name] = (guest, package)
    if len(modules) > MAX_MODULES or not 1 <= len(roots) <= 64:
        raise ValueError('static graph inventory limit')
    visited = {};bindings = {};stars = {};module_imports = {};edges = [];optional = [];deferred = [];root_records = [];aliases = {};native_stars = {}
    total = 0

    def parse(data):
        nonlocal total
        if type(data) is not bytes or not 1 <= len(data) <= MAX_SOURCE:
            raise ValueError('bounded static Python source required')
        total += len(data)
        if total > 32 * MAX_SOURCE:
            raise ValueError('static graph aggregate source limit')
        tree = ast.parse(data)
        if sum(1 for _ in ast.walk(tree)) > 200000:
            raise ValueError('static graph AST limit')
        return tree

    def imports(body, conditional=None, lazy=False):
        for node in body:
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                yield node, conditional, lazy
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                yield from imports(node.body, conditional, True)
            elif isinstance(node, ast.ClassDef):
                yield from imports(node.body, conditional, lazy)
            elif isinstance(node, (ast.Try, ast.TryStar)):
                fallback = any(isinstance(handler.type, ast.Name) and handler.type.id in ('ImportError', 'ModuleNotFoundError') or isinstance(handler.type, ast.Tuple) and any(isinstance(value, ast.Name) and value.id in ('ImportError', 'ModuleNotFoundError') for value in handler.type.elts) for handler in node.handlers)
                yield from imports(node.body, conditional or ('try-import-error' if fallback else None), lazy)
                for handler in node.handlers:
                    yield from imports(handler.body, conditional or 'except-branch', lazy)
                yield from imports(node.orelse, conditional or 'try-else', lazy)
                yield from imports(node.finalbody, conditional, lazy)
            elif isinstance(node, (ast.If, ast.For, ast.AsyncFor, ast.While)):
                yield from imports(node.body, conditional or 'conditional-branch', lazy)
                yield from imports(node.orelse, conditional or 'conditional-branch', lazy)
            elif isinstance(node, ast.Match):
                for case in node.cases:
                    yield from imports(case.body, conditional or 'conditional-branch', lazy)
            elif isinstance(node, (ast.With, ast.AsyncWith)):
                yield from imports(node.body, conditional, lazy)

    def declared(body, owner):
        # Module-scope exported bindings, including conditional definitions.
        # Their runtime values/presence remain unverified, especially __getattr__.
        names = set()
        for node in body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names.add(node.name)
            elif isinstance(node, ast.Import):
                names.update(alias.asname or alias.name.split('.')[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                module_imports.setdefault(owner, set()).add((node.lineno, node.col_offset))
                # Imported attributes are syntactic exports even in optional
                # branches. A package's own `from . import missing` must not
                # predeclare missing and satisfy that same required import.
                if absolute(node, owner) != owner:
                    names.update(alias.asname or alias.name for alias in node.names if alias.name != '*')
            elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                names.update(child.id for target in targets for child in ast.walk(target) if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store))
            elif isinstance(node, (ast.If, ast.For, ast.AsyncFor, ast.While, ast.With, ast.AsyncWith, ast.Try, ast.TryStar)):
                targets = [node.target] if isinstance(node, (ast.For, ast.AsyncFor)) else [item.optional_vars for item in node.items if item.optional_vars is not None] if isinstance(node, (ast.With, ast.AsyncWith)) else []
                names.update(child.id for target in targets for child in ast.walk(target) if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store))
                for field in ('body', 'orelse', 'finalbody'):
                    names.update(declared(getattr(node, field, []), owner))
                for handler in getattr(node, 'handlers', []):
                    names.update(declared(handler.body, owner))
        return names

    def absolute(node, owner):
        if not node.level:
            return node.module or ''
        package = owner if modules.get(owner, (None, False))[1] else owner.rpartition('.')[0]
        parts = package.split('.') if package else []
        if node.level > len(parts):
            raise ValueError('invalid relative import in ' + owner)
        base = '.'.join(parts[:len(parts) - node.level + 1])
        return base + ('.' + node.module if node.module else '')

    def linux_os_alias(tree):
        # Only this source-declared alias is supported. Never consult host os.path.
        if 'posix' not in builtins or 'nt' in builtins:
            raise ValueError('os.path alias requires Linux posix builtin evidence')
        def membership(node, name):
            return isinstance(node, ast.Compare) and isinstance(node.left, ast.Constant) and node.left.value == name and len(node.ops) == len(node.comparators) == 1 and isinstance(node.ops[0], ast.In) and isinstance(node.comparators[0], ast.Name) and node.comparators[0].id == '_names'
        def path_import(node, module):
            return isinstance(node, ast.Import) and len(node.names) == 1 and node.names[0].name == module and node.names[0].asname == 'path'
        names = [node for node in tree.body if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id == '_names' and isinstance(node.value, ast.Attribute) and isinstance(node.value.value, ast.Name) and node.value.value.id == 'sys' and node.value.attr == 'builtin_module_names']
        branches = [node for node in tree.body if isinstance(node, ast.If) and membership(node.test, 'posix')]
        registrations = [node for node in tree.body if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Subscript) and isinstance(node.targets[0].value, ast.Attribute) and isinstance(node.targets[0].value.value, ast.Name) and node.targets[0].value.value.id == 'sys' and node.targets[0].value.attr == 'modules' and isinstance(node.targets[0].slice, ast.Constant) and node.targets[0].slice.value == 'os.path' and isinstance(node.value, ast.Name) and node.value.id == 'path']
        sys_imports = [node for node in tree.body if isinstance(node, ast.Import) and any(alias.name == 'sys' and alias.asname is None for alias in node.names)]
        if len(names) != 1 or len(branches) != 1 or len(registrations) != 1 or len(sys_imports) != 1 or not sys_imports[0].lineno < names[0].lineno < branches[0].lineno < registrations[0].lineno:
            raise ValueError('captured os.path alias source changed')
        branch = branches[0]
        posix_bindings = [node for node in branch.body if path_import(node, 'posixpath')]
        nt_branch = branch.orelse[0] if len(branch.orelse) == 1 and isinstance(branch.orelse[0], ast.If) and membership(branch.orelse[0].test, 'nt') else None
        nt_bindings = [node for node in nt_branch.body if path_import(node, 'ntpath')] if nt_branch else []
        if len(posix_bindings) != 1 or len(nt_bindings) != 1:
            raise ValueError('captured os.path alias binding changed')
        native_imports = [node for node in branch.body if isinstance(node, ast.ImportFrom) and node.module == 'posix' and node.level == 0 and len(node.names) == 1 and node.names[0].name == '*' and node.names[0].asname is None]
        branch_stars = [node for statement in branch.body for node in ast.walk(statement) if isinstance(node, ast.ImportFrom) and any(alias.name == '*' for alias in node.names)]
        if len(native_imports) != 1 or branch_stars != native_imports:
            raise ValueError('captured Linux os native star provider changed')
        allowed = {'sys':sys_imports, '_names':names, 'path':posix_bindings + nt_bindings}
        def check_bindings(body):
            for node in body:
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    continue
                bound = set()
                if isinstance(node, ast.Import):
                    bound.update(alias.asname or alias.name.split('.')[0] for alias in node.names)
                elif isinstance(node, ast.ImportFrom):
                    bound.update(alias.asname or alias.name for alias in node.names)
                elif isinstance(node, ast.ExceptHandler) and node.name:
                    bound.add(node.name)
                else:
                    for field in ('targets', 'target', 'optional_vars'):
                        value = getattr(node, field, None)
                        for target in value if isinstance(value, list) else [value] if value is not None else []:
                            bound.update(child.id for child in ast.walk(target) if isinstance(child, ast.Name) and isinstance(child.ctx, (ast.Store, ast.Del)))
                if isinstance(node, ast.Delete) and bound == {'_names'} and node.lineno > registrations[0].lineno:
                    bound.clear()  # The fixed source deletes this temporary after registration.
                if any(name in bound and node not in nodes for name, nodes in allowed.items()):
                    raise ValueError('contradictory captured os.path alias binding')
                if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.Delete)):
                    for target in node.targets if isinstance(node, (ast.Assign, ast.Delete)) else [node.target]:
                        if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == 'sys' and target.attr == 'modules':
                            raise ValueError('contradictory captured os.path alias registration')
                        if isinstance(target, ast.Subscript) and isinstance(target.value, ast.Attribute) and isinstance(target.value.value, ast.Name) and target.value.value.id == 'sys' and target.value.attr == 'modules' and isinstance(target.slice, ast.Constant) and target.slice.value == 'posix':
                            raise ValueError('contradictory captured os native provider registration')
                        if isinstance(target, ast.Subscript) and isinstance(target.value, ast.Attribute) and isinstance(target.value.value, ast.Name) and target.value.value.id == 'sys' and target.value.attr == 'modules' and isinstance(target.slice, ast.Constant) and target.slice.value == 'os.path' and node not in registrations:
                            raise ValueError('contradictory captured os.path alias registration')
                for field in ('body', 'orelse', 'finalbody', 'handlers'):
                    check_bindings(getattr(node, field, []))
        check_bindings(tree.body)
        aliases['os.path'] = {'target':'posixpath', 'sourceGuest':modules['os'][0], 'sourceSha256':visited['os']['sha256'], 'bindingLine':posix_bindings[0].lineno, 'registrationLine':registrations[0].lineno, 'interpreterPlatform':interpreter_platform, 'builtin':'posix'}
        stars['os'].append('posix')
        edges.append({'importer':'os', 'module':'posix', 'line':native_imports[0].lineno})
        native_stars['os'] = {'provider':'posix', 'sourceGuest':modules['os'][0], 'sourceSha256':visited['os']['sha256'], 'branchLine':branch.lineno, 'importLine':native_imports[0].lineno, 'interpreterPlatform':interpreter_platform, 'nativeAttributesVerified':False}

    def exported(module, symbol, seen=None):
        module = aliases.get(module, {}).get('target', module)
        if module in builtins or module in visited and visited[module]['role'] == 'extension':
            return True  # Attribute validation would require executing native code.
        seen = set() if seen is None else seen
        if module in seen:
            return False
        seen.add(module)
        return symbol in bindings.get(module, set()) or any(exported(provider, symbol, seen) for provider in stars.get(module, []))

    def ensure(module, importer):
        if module == 'os.path':
            ensure('os', importer)
            if module not in aliases:
                raise ValueError('captured os.path alias required')
            ensure(aliases[module]['target'], importer)
            return
        if module in builtins:
            return
        if module not in modules:
            raise ValueError('missing required captured module: ' + module + ' (from ' + importer + ')')
        guest, package = modules[module]
        parent = module.rpartition('.')[0]
        if parent:
            if parent not in modules or not modules[parent][1]:
                raise ValueError('missing required captured package: ' + parent)
            ensure(parent, importer)
        if module in visited:
            return
        data = read_source(guest);item = files[guest]
        if len(data) != item['bytes'] or digest(data) != item['sha256']:
            raise ValueError('static source measurement changed: ' + module)
        visited[module] = {'guest':guest, 'role':item['role'], 'sha256':item['sha256'], 'bytes':item['bytes']}
        if item['role'] == 'extension':
            return
        tree = parse(data);bindings[module] = declared(tree.body, module);stars[module] = []
        if module == 'os':
            linux_os_alias(tree)
        walk(tree, module)

    def walk(tree, owner):
        for node, reason, lazy in imports(tree.body):
            targets = [alias.name for alias in node.names] if isinstance(node, ast.Import) else [absolute(node, owner)]
            record = {'importer':owner, 'line':node.lineno, 'modules':targets}
            if isinstance(node, ast.ImportFrom):
                record['names'] = [alias.name for alias in node.names]
            if lazy or reason:
                candidates = targets + ([targets[0] + '.' + alias.name for alias in node.names if alias.name != '*'] if isinstance(node, ast.ImportFrom) else [])
                record.update(reason='function-lazy' if lazy else reason, captured={name:name in modules or name in builtins or name in aliases for name in candidates})
                (deferred if lazy else optional).append(record)
            else:
                for target in targets:
                    edges.append({'importer':owner, 'module':target, 'line':node.lineno})
                    ensure(target, owner)
                if isinstance(node, ast.ImportFrom):
                    target = targets[0]
                    for alias in node.names:
                        if alias.name == '*':
                            if (node.lineno, node.col_offset) in module_imports.get(owner, set()):
                                stars.setdefault(owner, []).append(target)
                        elif not exported(target, alias.name):
                            child = target + '.' + alias.name
                            edges.append({'importer':owner, 'module':child, 'line':node.lineno})
                            ensure(child, owner)
                        if alias.name != '*' and (node.lineno, node.col_offset) in module_imports.get(owner, set()):
                            bindings.setdefault(owner, set()).add(alias.asname or alias.name)
            if len(edges) + len(optional) + len(deferred) > MAX_IMPORTS:
                raise ValueError('static graph import limit')

    for label, data in roots:
        if type(label) is not str or not re.fullmatch(r'(?:smoke:[0-9]+|descendant|test:[0-9]+)', label):
            raise ValueError('fixed payload root label')
        root_records.append({'id':label, 'sha256':digest(data), 'bytes':len(data)})
        walk(parse(data), label)
    for seed in seeds:
        edges.append({'importer':'fixed-exercised-seed', 'module':seed, 'line':0});ensure(seed, 'fixed-exercised-seed')
    result = {'kind':'winter-utility-static-stdlib-graph', 'version':1, 'roots':root_records,
            'exercisedSeeds':list(seeds), 'builtinInterpreter':builder_identity,
            'interpreterPlatform':interpreter_platform, 'aliases':aliases,
            'selectedNativeStarProviders':native_stars,
            'builtinModules':sorted(builtins), 'visited':dict(sorted(visited.items())),
            'requiredEdges':edges, 'optionalImports':optional, 'deferredImports':deferred,
            'requiredStaticImportsCaptured':True, 'dynamicCompletenessVerified':False,
            'optionalBranchesVerified':False, 'nativeExecutionVerified':False}
    if len(json.dumps(result, sort_keys=True, separators=(',', ':')).encode()) > 8 * 1024 * 1024:
        raise ValueError('static graph receipt limit')
    return result
