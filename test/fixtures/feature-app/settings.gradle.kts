pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

rootProject.name = "feature-app"
include(":app", ":core:data")
include(":feature:login", ":feature:payment", ":feature:profile", ":feature:legacy-reports")
