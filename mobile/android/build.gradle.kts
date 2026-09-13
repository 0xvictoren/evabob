allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}

// Raise compileSdk on every Android library module (plugins often pin 34).
subprojects {
    afterEvaluate {
        val android = extensions.findByName("android") ?: return@afterEvaluate
        try {
            val method = android.javaClass.methods.firstOrNull { m ->
                m.name == "setCompileSdk" && m.parameterCount == 1
            }
            method?.invoke(android, 36)
            val method2 = android.javaClass.methods.firstOrNull { m ->
                m.name == "setCompileSdkVersion" && m.parameterCount == 1
            }
            method2?.invoke(android, 36)
        } catch (_: Throwable) {
            // ignore
        }
    }
}

subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
