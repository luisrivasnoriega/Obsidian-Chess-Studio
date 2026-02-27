import java.io.File
import javax.inject.Inject
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.ProjectLayout
import org.gradle.api.logging.LogLevel
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction
import org.gradle.process.ExecOperations

abstract class BuildTask @Inject constructor(
    private val execOperations: ExecOperations,
    private val projectLayout: ProjectLayout,
) : DefaultTask() {
    @get:Input
    abstract val rootDirRel: Property<String>

    @get:Input
    abstract val target: Property<String>

    @get:Input
    abstract val release: Property<Boolean>

    @TaskAction
    fun assemble() {
        val executable = "pnpm"
        try {
            runTauriCli(executable)
        } catch (e: Exception) {
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                // Try different Windows-specific extensions
                val fallbacks = listOf(
                    "$executable.exe",
                    "$executable.cmd",
                    "$executable.bat",
                )
                
                var lastException: Exception = e
                for (fallback in fallbacks) {
                    try {
                        runTauriCli(fallback)
                        return
                    } catch (fallbackException: Exception) {
                        lastException = fallbackException
                    }
                }
                throw lastException
            } else {
                throw e
            }
        }
    }

    fun runTauriCli(executable: String) {
        val rootDirPath =
            rootDirRel.orNull ?: throw GradleException("rootDirRel cannot be null")
        val rustTarget = target.orNull ?: throw GradleException("target cannot be null")
        val releaseBuild = release.orNull ?: throw GradleException("release cannot be null")
        val args = listOf("tauri", "android", "android-studio-script")

        execOperations.exec {
            workingDir(File(projectLayout.projectDirectory.asFile, rootDirPath))
            executable(executable)
            args(args)
            if (logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (releaseBuild) {
                args("--release")
            }
            args(listOf("--target", rustTarget))
        }.assertNormalExitValue()
    }
}
