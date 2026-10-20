def version = ''
node('linux') {
    stage('Checkout') {
        checkout scm
        version = sh(script: 'cat VERSION', returnStdout: true).trim()
    }
    stage('Build') {
        withEnv(["VERSION=${version}", 'CI=true']) {
            sh 'make build'
        }
    }
    stage('Test') {
        try {
            sh 'make test'
        } finally {
            junit 'reports/*.xml'
        }
    }
    if (env.BRANCH_NAME == 'main') {
        stage('Publish') {
            withCredentials([string(credentialsId: 'npm-token', variable: 'NPM_TOKEN')]) {
                sh 'npm publish'
            }
        }
    }
}
