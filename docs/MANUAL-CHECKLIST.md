# Manual click-through after the first release (about 10 minutes per OS)

Do this on a machine that did NOT build the app, with the downloaded installer. Tick each line.

**Install and launch**
- [ ] Installer opens; after the OS warning (see RELEASING.md) the app starts; the window title is "SequenceScope".
- [ ] The app icon (violet-to-cyan square with two bars and a small tree) shows in the dock/taskbar and in the installer.
- [ ] Turn Wi-Fi off and restart the app: everything below still works (the app never needs a network).
- [ ] The menu bar shows File, Edit, View, Help (on macOS also the app menu); File ▸ Open FASTA… (Ctrl/Cmd+O), Save Project… (Ctrl/Cmd+S), Export… (Ctrl/Cmd+E) and View ▸ Align … About (Ctrl/Cmd+1…7) work. Copy and paste work inside the text boxes.

**Align (view 1)**
- [ ] Pick the example pair "…unrelated…": a score appears, the matrix heatmap draws, the alignment shows letters in colour.
- [ ] Click a matrix cell: the right panel explains its value. Press Home / Right-arrow on the step-through; Space plays; the end matches the final alignment.
- [ ] Switch Mode to Local and the gap model to Affine: the score changes and the explanation text updates.
- [ ] Shuffle test: run with the default seed twice → identical numbers. Run 5000 shuffles and press Cancel.
- [ ] File ▸ Save Project…, quit the app, start it again, File ▸ Open Project…: same results.

**Distances, Trees, MSA (views 2-4)**
- [ ] Distances: load "Hemoglobin subunit alpha across 13 vertebrates — MAFFT-aligned copy": heatmap and table appear. Choose model Jukes–Cantor on a DNA set and check any saturated pair is flagged.
- [ ] Trees: switch between UPGMA and neighbor-joining, step through merges, re-root, midpoint root, collapse a clade, search a taxon, switch to the radial layout.
- [ ] Bootstrap: run 100 replicates (aligned data only); support values appear; the same seed repeats exactly.
- [ ] Export Newick, SVG and PNG; open them in another program.
- [ ] MSA: align an example set; select a column range; export aligned FASTA; "Build neighbor-joining tree + bootstrap" opens the Trees view.

**Other**
- [ ] Learn view: equations are readable (MathML); the correction plot and the UPGMA-vs-NJ example show.
- [ ] About: lists data sources and licenses. View ▸ Toggle Dark Mode (Ctrl/Cmd+D) works and is remembered after a restart.
- [ ] Help ▸ GitHub Repository opens your browser (the only network use, and only when you click it).
